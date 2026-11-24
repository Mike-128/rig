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
  type ConversationRequest,
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
  /** Set when the agent's own model is gone and the run falls back to the default alias. */
  notice?: string;
}

export type BusKey = `session:${string}` | `run:${string}` | "all";

/** How many agents deep a chain of conversations may go, counting the one the user talks to. */
export const MAX_CONVERSATION_DEPTH = 3;

/** Where an agent_message call comes from: the user's run at the top, and the agents waiting below it. */
interface ConversationLink {
  /** The run the user is watching; approvals are relayed to it. */
  root: { run: Run; state: ActiveRun; session: Session };
  /** Slugs of the agents waiting on this call, from the root down to the caller. */
  chain: string[];
  /** The calling agent and the session it is working in. */
  caller: { session: Session; agent: AgentDefinition };
}

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
  /** Conversations with a message in flight; a second message waits for the reply. */
  private conversing = new Set<string>();

  constructor(private maxConcurrent: number) {
    this.bus.setMaxListeners(500);
  }

  attach(app: AppContext): void {
    this.app = app;
  }

  /** Extra tools (MCP) the runtime offers on top of the builtins. Replaced when servers connect. */
  extraTools: () => ToolSpec[] = () => [];

  /** The model an alias is bound to, when the binding and its target still exist. */
  private aliasTarget(alias: string): ResolvedModel | undefined {
    const { models, connections } = this.app;
    const a = models.getAlias(alias);
    const conn = a && connections.get(a.connectionId);
    const model = conn && models.find(conn.id, a.modelId);
    return conn && model ? { connection: conn, model } : undefined;
  }

  /**
   * Resolve an agent's model binding to a concrete connection and model. An agent pinned to a
   * provider or model that was since removed runs on the default model, with a notice saying so.
   */
  resolveModel(agent: AgentDefinition): ResolvedModel {
    const { models, connections } = this.app;
    if ("alias" in agent.model) {
      const target = this.aliasTarget(agent.model.alias);
      if (target) return target;
      if (!models.getAlias(agent.model.alias)) throw new Error(`${agent.name} uses the alias "${agent.model.alias}", which is not set. Choose a model for it in Settings › Models.`);
      throw new Error(`The alias "${agent.model.alias}" points at a provider or model that was removed. Choose another model for it in Settings › Models.`);
    }
    const conn = connections.get(agent.model.connection) ?? connections.getByName(agent.model.connection);
    const model = conn && models.find(conn.id, agent.model.model);
    if (conn && model) return { connection: conn, model };
    const missing = conn ? `the model "${agent.model.model}" on ${conn.name}, which was removed` : `a provider that was removed (${agent.model.connection})`;
    const fallback = this.aliasTarget("default");
    if (!fallback) throw new Error(`${agent.name} is set to ${missing}, and no default model is set. Choose a model for ${agent.name} on the Agents page.`);
    return { ...fallback, notice: `${agent.name} is set to ${missing}, so this run uses your default model, ${fallback.model.displayName}. Choose a model for ${agent.name} on the Agents page to keep it.` };
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
      const { connection, model, notice } = this.resolveModel(agent);
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
      if (notice) this.emit(run, { type: "warning", message: notice });

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
          contacts: this.contactsFor(agent),
        },
        host: createHost(this.app, agent, current.workspace),
        takeSteering: () => this.takeInbox(session.id),
        onAllowRule: (rule) => sessions.addAllowRule(session.id, rule),
        runSubagent: (req, ctx) => this.runSubagent(run, current, agent, req, ctx),
        messageAgent: (req, ctx) => this.converse({ root: { run, state, session: current }, chain: [agent.slug], caller: { session: current, agent } }, req, ctx),
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
      run.status = "failed";
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

  /** The agents an agent may talk to with agent_message: its talksTo list, or every other saved agent. */
  private contactsFor(agent: AgentDefinition): { slug: string; name: string; description?: string }[] {
    if (!agent.tools.includes("agent_message")) return [];
    const all = this.app.agents.list().filter((a) => a.slug !== agent.slug);
    const allowed = agent.talksTo?.length ? all.filter((a) => agent.talksTo!.includes(a.slug)) : all;
    return allowed.map((a) => ({ slug: a.slug, name: a.name, description: a.description }));
  }

  /**
   * One message in a conversation between agents: start or continue a saved conversation session,
   * run the other agent on it with everything said so far, and return its reply. The other agent
   * works in the caller's folder under the user's session mode and rules; anything it needs
   * approved is asked of the user in the session they are watching.
   */
  private async converse(link: ConversationLink, req: ConversationRequest, ctx: { signal: AbortSignal; onProgress?: (text: string) => void }): Promise<ToolResult> {
    const { sessions, agents } = this.app;
    const { caller } = link;
    const fail = (output: string): ToolResult => ({ output, isError: true });
    const contacts = () => {
      const list = this.contactsFor(caller.agent);
      return list.length ? `You can talk to: ${list.map((c) => c.slug).join(", ")}.` : "There are no other agents to talk to.";
    };

    let convo: Session | undefined;
    let callee: AgentDefinition | undefined;
    if (req.conversation) {
      convo = sessions.getSession(req.conversation);
      if (!convo || convo.kind !== "conversation" || convo.parent?.sessionId !== caller.session.id) {
        return fail(`There is no conversation "${req.conversation}" started from here. Start one by naming the agent.`);
      }
      if (req.agent && req.agent !== convo.agentSlug) return fail(`Conversation ${convo.id} is with ${convo.agentSlug}, not ${req.agent}.`);
      callee = agents.getVersion(convo.agentSlug, convo.agentVersion) ?? agents.get(convo.agentSlug);
      if (!callee) return fail(`The agent "${convo.agentSlug}" in this conversation no longer exists.`);
    } else {
      callee = agents.get(req.agent!);
      if (!callee) return fail(`There is no agent "${req.agent}". ${contacts()}`);
    }
    if (callee.slug === caller.agent.slug) return fail("You cannot hold a conversation with yourself.");
    if (caller.agent.talksTo?.length && !caller.agent.talksTo.includes(callee.slug)) {
      return fail(`${caller.agent.name} is not set up to talk to ${callee.name}. ${contacts()}`);
    }
    if (link.chain.includes(callee.slug)) {
      return fail(`${callee.name} is waiting for your reply in this chain of conversations, so it cannot take a new message now. Put what it needs in your reply instead.`);
    }
    if (link.chain.length >= MAX_CONVERSATION_DEPTH) {
      return fail(`Conversations can go ${MAX_CONVERSATION_DEPTH} agents deep, and this one is already that deep. Do the work yourself, or say in your reply what is still needed.`);
    }
    if (convo && this.conversing.has(convo.id)) return fail(`${callee.name} is still answering an earlier message in conversation ${convo.id}. Wait for that reply before sending another.`);

    let resolved: ResolvedModel;
    try {
      resolved = this.resolveModel(callee);
    } catch (e) {
      return fail((e as Error).message);
    }
    if (!convo) {
      convo = sessions.createSession({
        id: newId("sess"),
        kind: "conversation",
        agentSlug: callee.slug,
        agentVersion: callee.version,
        workspace: caller.session.workspace,
        title: `${caller.agent.name} → ${callee.name}: ${req.message.replace(/\s+/g, " ").trim().slice(0, 60)}`,
        parent: { sessionId: caller.session.id, agentSlug: caller.agent.slug, agentName: caller.agent.name },
      });
    }
    const conversation = convo;
    const agent = callee;
    this.conversing.add(conversation.id);
    const run = sessions.createRun(newId("run"), conversation.id);
    sessions.updateRun(run.id, { status: "running", startedAt: nowIso() });
    run.status = "running";

    const progress = (line: string) => ctx.onProgress?.(`${line}\n`);
    progress(`▸ ${agent.name} (conversation ${conversation.id})`);
    let reply = "";
    let error: string | undefined;
    try {
      const root = link.root;
      const tools = toolsFor(agent.tools, this.extraTools());
      const { connection, model, notice } = resolved;
      this.emit(run, {
        type: "run_started",
        agent: { slug: agent.slug, version: agent.version },
        model: { connectionId: connection.id, modelId: model.providerModelId, dialect: model.dialect, contextWindow: model.capabilities.maxContextTokens },
      });
      if (notice) this.emit(run, { type: "warning", message: notice });
      const rootSession = sessions.getSession(root.session.id) ?? root.session;
      const gen = runNativeEngine({
        agent,
        model,
        adapter: adapterFor(model.dialect),
        connection: adapterConnection(this.app, connection, model),
        history: projectMessages(sessions.sessionEvents(conversation.id)),
        userTurn: req.message,
        tools,
        // The user's session decides how much to ask, for every agent working on their behalf.
        policy: this.sessionPolicy(root.session.id, agent, tools),
        workspace: conversation.workspace,
        signal: ctx.signal,
        skills: this.app.skills.list(conversation.workspace),
        prompt: {
          project: loadProjectInstructions(conversation.workspace, this.app.config.home),
          env: environmentFacts(conversation.workspace),
          mode: rootSession.mode,
          memories: this.app.memory.list(),
          contacts: this.contactsFor(agent),
          conversationWith: caller.agent.name,
        },
        host: createHost(this.app, agent, conversation.workspace),
        onAllowRule: (rule) => sessions.addAllowRule(root.session.id, rule),
        runSubagent: (r, c) => this.runSubagent(run, conversation, agent, r, c),
        messageAgent: (r, c) => this.converse({ root, chain: [...link.chain, agent.slug], caller: { session: conversation, agent } }, r, c),
        requestApproval: (callId, name, input) => this.relayApproval(root, run, agent, conversation, callId, name, input, ctx.signal),
      });
      for await (const body of gen) {
        const ev = this.emit(run, body);
        if (ev.type === "tool_call") progress(`  ${agent.name}: ${ev.name} ${briefInput(ev.input)}`);
        else if (ev.type === "assistant_message") reply = textOf(ev.message) || reply;
        else if (ev.type === "run_failed") error = ev.error.message;
        else if (ev.type === "run_cancelled") error = "cancelled";
        if (TERMINAL_EVENTS.has(ev.type)) {
          const status = ev.type === "run_completed" ? "completed" : ev.type === "run_failed" ? "failed" : "cancelled";
          sessions.updateRun(run.id, { status, endedAt: nowIso(), usage: "usage" in ev ? ev.usage : undefined, costUsd: "costUsd" in ev ? ev.costUsd : undefined, error });
        }
      }
      sessions.touchSession(conversation.id);
    } catch (e) {
      error = (e as Error).message;
      this.emit(run, { type: "run_failed", error: { kind: "unknown", message: error, retryable: false }, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 });
      sessions.updateRun(run.id, { status: "failed", endedAt: nowIso(), error });
    } finally {
      this.conversing.delete(conversation.id);
    }

    const next = `To reply, call agent_message with conversation "${conversation.id}".`;
    if (error) {
      return fail(`${agent.name} could not answer (conversation ${conversation.id}): ${error}${reply ? `\n\nIts last message:\n${reply}` : ""}\n\n${next}`);
    }
    return { output: `${agent.name} replied (conversation ${conversation.id}):\n\n${reply || "(no reply text)"}\n\n${next}` };
  }

  /**
   * An approval another agent needs, asked in the run the user is watching. The request names the
   * agent and the conversation; the decision goes back to that agent.
   */
  private relayApproval(
    root: ConversationLink["root"],
    run: Run,
    agent: AgentDefinition,
    conversation: Session,
    callId: string,
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const { sessions } = this.app;
    const relayId = `${run.id}.${callId}`;
    return new Promise<ApprovalDecision>((resolve) => {
      root.state.approvals.set(relayId, (d) => {
        root.state.approvals.delete(relayId);
        sessions.updateRun(run.id, { status: "running" });
        if (!root.state.approvals.size) sessions.updateRun(root.run.id, { status: "running" });
        this.emit(root.run, { type: "approval_resolved", callId: relayId, decision: d });
        resolve(d);
      });
      sessions.updateRun(run.id, { status: "awaiting_approval" });
      sessions.updateRun(root.run.id, { status: "awaiting_approval" });
      this.emit(root.run, { type: "approval_requested", callId: relayId, name, input, via: { agent: agent.name, conversation: conversation.id } });
      signal.addEventListener("abort", () => root.state.approvals.get(relayId)?.("deny"), { once: true });
    });
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
