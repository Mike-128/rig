import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import {
  adapterFor,
  isTransient,
  MANAGEMENT_TOOLS,
  policyForAgent,
  projectMessages,
  runNativeEngine,
  TERMINAL_EVENTS,
  textOf,
  toolsFor,
  type AgentDefinition,
  type ApprovalDecision,
  type Connection,
  type Model,
  type PolicyEvaluator,
  type Run,
  type RunEvent,
  type RunEventBody,
  type Session,
  type SubagentRequest,
  type ToolResult,
  type ToolSpec,
} from "@rig/core";
import type { AppContext } from "./context";
import { adapterConnection } from "./catalog";
import { createHost } from "./host";
import { nowIso } from "./db";
import { newId } from "./ids";
import { environmentFacts, loadProjectInstructions } from "./project";

interface ActiveRun {
  run: Run;
  controller: AbortController;
  approvals: Map<string, (d: ApprovalDecision) => void>;
}

interface QueuedRun {
  run: Run;
  session: Session;
  input: string;
  /** What the user typed, when input is an expansion of it. */
  display?: string;
  compactOnly?: boolean;
}

export interface ResolvedModel {
  connection: Connection;
  model: Model;
}

export type BusKey = `session:${string}` | `run:${string}` | "all";

const SUBAGENT_INSTRUCTIONS = `You are a sub-agent: another agent has delegated one self-contained task to you. You cannot see its conversation and you cannot ask it or the user questions, so work from the task as written.

Work efficiently: search broadly with glob and grep, read only what you need, and stop as soon as you can answer. When you finish, reply with a concise report of exactly what the task asked for: findings with file paths and line numbers, what you changed if you changed anything, and anything you could not determine. Your final message is all the other agent will see.`;

/**
 * One scheduler: a queue with a global concurrency limit, per-run abort, approvals, and steering.
 * Persists non-transient events, broadcasts everything.
 */
export class RunManager {
  private active = new Map<string, ActiveRun>();
  private queue: QueuedRun[] = [];
  /** Messages typed while a session's run is working, waiting for the next turn boundary. */
  private inbox = new Map<string, string[]>();
  private bus = new EventEmitter();
  private app!: AppContext;

  constructor(private maxConcurrent: number) {
    this.bus.setMaxListeners(500);
  }

  attach(app: AppContext): void {
    this.app = app;
  }

  /** Extra tools (MCP) the runtime offers on top of the builtins. Replaced when servers connect. */
  extraTools: () => ToolSpec[] = () => [];

  /** Resolve an agent's model binding to a concrete connection and model. */
  resolveModel(agent: AgentDefinition): ResolvedModel {
    const { models, connections } = this.app;
    if ("alias" in agent.model) {
      const a = models.getAlias(agent.model.alias);
      if (!a) throw new Error(`Alias "${agent.model.alias}" is not set. Bind it in the Model Catalog.`);
      const conn = connections.get(a.connectionId);
      const model = conn && models.find(conn.id, a.modelId);
      if (!conn || !model) throw new Error(`Alias "${agent.model.alias}" points at a missing connection or model`);
      return { connection: conn, model };
    }
    const conn = connections.get(agent.model.connection) ?? connections.getByName(agent.model.connection);
    if (!conn) throw new Error(`Connection "${agent.model.connection}" not found`);
    const model = models.find(conn.id, agent.model.model);
    if (!model) throw new Error(`Model "${agent.model.model}" not found on connection "${conn.name}"`);
    return { connection: conn, model };
  }

  submit(session: Session, input: string, opts: { compactOnly?: boolean; display?: string } = {}): Run {
    const run = this.app.sessions.createRun(newId("run"), session.id);
    this.queue.push({ run, session, input, display: opts.display, compactOnly: opts.compactOnly });
    this.pump();
    return run;
  }

  /** The session's run that is queued or working, if any. */
  activeRunFor(sessionId: string): Run | undefined {
    for (const a of this.active.values()) if (a.run.sessionId === sessionId) return a.run;
    return this.queue.find((q) => q.session.id === sessionId)?.run;
  }

  /**
   * Hand a message to the session's working run. It reaches the model at the next turn boundary
   * (after the current tool calls), or starts the next run if the current one ends first.
   */
  steer(sessionId: string, text: string): boolean {
    if (!this.activeRunFor(sessionId)) return false;
    const box = this.inbox.get(sessionId) ?? [];
    box.push(text);
    this.inbox.set(sessionId, box);
    return true;
  }

  private takeInbox(sessionId: string): string[] {
    const box = this.inbox.get(sessionId) ?? [];
    this.inbox.delete(sessionId);
    return box;
  }

  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length) {
      const next = this.queue.shift()!;
      void this.execute(next);
    }
  }

  private emit(run: Run, body: RunEventBody): RunEvent {
    const ts = nowIso();
    const ev: RunEvent = isTransient(body)
      ? { ...body, runId: run.id, sessionId: run.sessionId, ts }
      : this.app.sessions.appendEvent(run.id, run.sessionId, body, ts);
    this.bus.emit(`session:${run.sessionId}`, ev);
    this.bus.emit(`run:${run.id}`, ev);
    if (!isTransient(body)) this.bus.emit("all", ev);
    return ev;
  }

  /** The session's live permission mode and rules, read on every tool call so changes apply mid-run. */
  private sessionPolicy(sessionId: string, agent: AgentDefinition, tools: ToolSpec[]): PolicyEvaluator {
    return policyForAgent(agent, tools, {
      mode: () => this.app.sessions.getSession(sessionId)?.mode ?? "default",
      rules: () => this.app.sessions.getSession(sessionId)?.allowRules ?? [],
    });
  }

  private async execute(q: QueuedRun): Promise<void> {
    const { run, session } = q;
    const controller = new AbortController();
    const state: ActiveRun = { run, controller, approvals: new Map() };
    this.active.set(run.id, state);
    const { sessions, agents } = this.app;
    sessions.updateRun(run.id, { status: "running", startedAt: nowIso() });
    run.status = "running";

    try {
      const current = sessions.getSession(session.id) ?? session;
      const agent = agents.getVersion(current.agentSlug, current.agentVersion) ?? agents.get(current.agentSlug);
      if (!agent) throw new Error(`Agent "${current.agentSlug}" not found`);
      const { connection, model } = this.resolveModel(agent);
      if (model.status !== "entitled" && model.status !== "unprobed" && model.status !== "listed" && model.status !== "rate_limited") {
        this.emit(run, { type: "warning", message: `Model ${model.providerModelId} last probed as ${model.status}; trying anyway` });
      }
      mkdirSync(current.workspace, { recursive: true });
      const tools = toolsFor(agent.tools, this.extraTools());
      const history = projectMessages(sessions.sessionEvents(session.id));

      this.emit(run, {
        type: "run_started",
        agent: { slug: agent.slug, version: agent.version },
        model: { connectionId: connection.id, modelId: model.providerModelId, dialect: model.dialect, contextWindow: model.capabilities.maxContextTokens },
      });

      const gen = runNativeEngine({
        agent,
        model,
        adapter: adapterFor(model.dialect),
        connection: adapterConnection(this.app, connection, model),
        history,
        userTurn: q.compactOnly ? undefined : q.input,
        userDisplay: q.display,
        compactOnly: q.compactOnly,
        tools,
        policy: this.sessionPolicy(session.id, agent, tools),
        workspace: current.workspace,
        signal: controller.signal,
        skills: this.app.skills.list(current.workspace),
        prompt: {
          project: loadProjectInstructions(current.workspace, this.app.config.home),
          env: environmentFacts(current.workspace),
          mode: current.mode,
          memories: this.app.memory.list(),
        },
        host: createHost(this.app, agent, current.workspace),
        takeSteering: () => this.takeInbox(session.id),
        onAllowRule: (rule) => sessions.addAllowRule(session.id, rule),
        runSubagent: (req, ctx) => this.runSubagent(run, current, agent, req, ctx),
        requestApproval: (callId) =>
          new Promise<ApprovalDecision>((resolve) => {
            state.approvals.set(callId, (d) => {
              state.approvals.delete(callId);
              sessions.updateRun(run.id, { status: "running" });
              resolve(d);
            });
            sessions.updateRun(run.id, { status: "awaiting_approval" });
            const onAbort = () => state.approvals.get(callId)?.("deny");
            controller.signal.addEventListener("abort", onAbort, { once: true });
          }),
      });

      for await (const body of gen) {
        const ev = this.emit(run, body);
        if (TERMINAL_EVENTS.has(ev.type)) {
          const status = ev.type === "run_completed" ? "completed" : ev.type === "run_failed" ? "failed" : "cancelled";
          const usage = "usage" in ev ? ev.usage : undefined;
          const costUsd = "costUsd" in ev ? ev.costUsd : undefined;
          const error = ev.type === "run_failed" ? ev.error.message : undefined;
          sessions.updateRun(run.id, { status, endedAt: nowIso(), usage, costUsd, error });
        }
      }
      if (current.title === "New session" && q.input) sessions.touchSession(session.id, (q.display ?? q.input).slice(0, 60));
      else sessions.touchSession(session.id);
    } catch (e) {
      const message = (e as Error).message;
      this.emit(run, { type: "run_failed", error: { kind: "unknown", message, retryable: false }, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 });
      sessions.updateRun(run.id, { status: "failed", endedAt: nowIso(), error: message });
    } finally {
      this.active.delete(run.id);
      // Anything typed after the model's last turn boundary becomes the next run, unless the user cancelled.
      const left = this.takeInbox(session.id);
      const latest = sessions.getRun(run.id);
      if (left.length && latest?.status !== "cancelled") {
        const s = sessions.getSession(session.id);
        if (s) this.submit(s, left.join("\n\n"));
      }
      this.pump();
    }
  }

  /**
   * The task tool: a nested engine in the same workspace that reports back once. It cannot spawn
   * further sub-agents, and it cannot stop to ask for approval: calls that would need approval are
   * refused unless the session's mode or rules already allow them, and it says so in its report.
   */
  private async runSubagent(
    parent: Run,
    session: Session,
    parentAgent: AgentDefinition,
    req: SubagentRequest,
    ctx: { signal: AbortSignal; onProgress?: (text: string) => void },
  ): Promise<ToolResult> {
    let agent: AgentDefinition;
    if (req.agent) {
      const found = this.app.agents.get(req.agent);
      if (!found) return { output: `No agent named "${req.agent}". Omit agent to use a general-purpose helper.`, isError: true };
      agent = { ...found, tools: found.tools.filter((t) => t !== "task") };
    } else {
      agent = {
        ...parentAgent,
        name: `${parentAgent.name} (sub-agent)`,
        instructions: SUBAGENT_INSTRUCTIONS,
        tools: parentAgent.tools.filter((t) => t !== "task" && !(MANAGEMENT_TOOLS as readonly string[]).includes(t)),
        approvals: parentAgent.approvals.filter((t) => t !== "task"),
        budget: { maxTurns: 50 },
      };
    }
    let resolved: ResolvedModel;
    try {
      resolved = this.resolveModel(agent);
    } catch (e) {
      return { output: (e as Error).message, isError: true };
    }
    const tools = toolsFor(agent.tools, this.extraTools());
    const inner = this.sessionPolicy(session.id, agent, tools);
    const policy: PolicyEvaluator = {
      evaluate(name, input) {
        const d = inner.evaluate(name, input);
        return d.decision === "require_approval"
          ? { decision: "deny", reason: `${name} needs the user's approval, which a sub-agent cannot ask for. Describe the change in your report instead.` }
          : d;
      },
    };
    let final = "";
    let error: string | undefined;
    const progress = (line: string) => ctx.onProgress?.(`${line}\n`);
    progress(`▸ ${req.description}`);
    for await (const ev of runNativeEngine({
      agent,
      model: resolved.model,
      adapter: adapterFor(resolved.model.dialect),
      connection: adapterConnection(this.app, resolved.connection, resolved.model),
      history: [],
      userTurn: req.prompt,
      tools,
      policy,
      workspace: session.workspace,
      signal: ctx.signal,
      skills: this.app.skills.list(session.workspace),
      prompt: { project: loadProjectInstructions(session.workspace, this.app.config.home), env: environmentFacts(session.workspace) },
      host: createHost(this.app, agent, session.workspace),
      requestApproval: async () => "deny",
    })) {
      if (ev.type === "tool_call") progress(`  ${ev.name} ${briefInput(ev.input)}`);
      else if (ev.type === "assistant_message") final = textOf(ev.message) || final;
      else if (ev.type === "usage") this.emit(parent, ev);
      else if (ev.type === "run_failed") error = ev.error.message;
      else if (ev.type === "run_cancelled") error = "cancelled";
    }
    if (error) return { output: `Sub-agent stopped: ${error}${final ? `\n\nLast report:\n${final}` : ""}`, isError: true };
    return { output: final || "(the sub-agent finished without a report)" };
  }

  approve(runId: string, callId: string, decision: ApprovalDecision): boolean {
    const resolver = this.active.get(runId)?.approvals.get(callId);
    if (!resolver) return false;
    resolver(decision);
    return true;
  }

  pendingApprovals(runId: string): string[] {
    return [...(this.active.get(runId)?.approvals.keys() ?? [])];
  }

  cancel(runId: string): boolean {
    const a = this.active.get(runId);
    if (a) {
      this.inbox.delete(a.run.sessionId);
      a.controller.abort();
      return true;
    }
    const qi = this.queue.findIndex((q) => q.run.id === runId);
    if (qi >= 0) {
      const [q] = this.queue.splice(qi, 1);
      this.app.sessions.updateRun(q.run.id, { status: "cancelled", endedAt: nowIso() });
      this.emit(q.run, { type: "run_cancelled", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 });
      return true;
    }
    return false;
  }

  isActive(runId: string): boolean {
    return this.active.has(runId) || this.queue.some((q) => q.run.id === runId);
  }

  /** Runs waiting on the user, across all sessions; the desktop shell badges and notifies on these. */
  awaitingApproval(): { runId: string; sessionId: string; callIds: string[] }[] {
    return [...this.active.values()]
      .filter((a) => a.approvals.size)
      .map((a) => ({ runId: a.run.id, sessionId: a.run.sessionId, callIds: [...a.approvals.keys()] }));
  }

  subscribe(key: BusKey, fn: (ev: RunEvent) => void): () => void {
    this.bus.on(key, fn);
    return () => this.bus.off(key, fn);
  }
}

function briefInput(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const v = o.path ?? o.pattern ?? o.command ?? o.url ?? o.name ?? o.description;
  const s = typeof v === "string" ? v : JSON.stringify(o);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
