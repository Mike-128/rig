import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  adapterFor,
  isTransient,
  policyForAgent,
  projectMessages,
  runNativeEngine,
  TERMINAL_EVENTS,
  toolsFor,
  type AgentDefinition,
  type ApprovalDecision,
  type Connection,
  type Model,
  type Run,
  type RunEvent,
  type RunEventBody,
  type Session,
} from "@harness/core";
import type { AppContext } from "./context";
import { adapterConnection } from "./catalog";
import { createHost } from "./host";
import { nowIso } from "./db";
import { newId } from "./ids";

interface ActiveRun {
  run: Run;
  controller: AbortController;
  approvals: Map<string, (d: ApprovalDecision) => void>;
}

export interface ResolvedModel {
  connection: Connection;
  model: Model;
}

/**
 * One scheduler: a queue with a global concurrency limit, per-run abort, and approvals.
 * Persists non-transient events, broadcasts everything.
 */
export class RunManager {
  private active = new Map<string, ActiveRun>();
  private queue: { run: Run; session: Session; input: string }[] = [];
  private bus = new EventEmitter();
  private app!: AppContext;

  constructor(private maxConcurrent: number) {
    this.bus.setMaxListeners(200);
  }

  attach(app: AppContext): void {
    this.app = app;
  }

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

  submit(session: Session, input: string): Run {
    const run = this.app.sessions.createRun(newId("run"), session.id);
    this.queue.push({ run, session, input });
    this.pump();
    return run;
  }

  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length) {
      const next = this.queue.shift()!;
      void this.execute(next.run, next.session, next.input);
    }
  }

  private emit(run: Run, body: RunEventBody): RunEvent {
    const ts = nowIso();
    const ev: RunEvent = isTransient(body)
      ? { ...body, runId: run.id, sessionId: run.sessionId, ts }
      : this.app.sessions.appendEvent(run.id, run.sessionId, body, ts);
    this.bus.emit(`session:${run.sessionId}`, ev);
    this.bus.emit(`run:${run.id}`, ev);
    return ev;
  }

  private async execute(run: Run, session: Session, input: string): Promise<void> {
    const controller = new AbortController();
    const state: ActiveRun = { run, controller, approvals: new Map() };
    this.active.set(run.id, state);
    const { sessions, agents } = this.app;
    sessions.updateRun(run.id, { status: "running", startedAt: nowIso() });
    run.status = "running";

    try {
      const agent = agents.getVersion(session.agentSlug, session.agentVersion) ?? agents.get(session.agentSlug);
      if (!agent) throw new Error(`Agent "${session.agentSlug}" not found`);
      const { connection, model } = this.resolveModel(agent);
      if (model.status !== "entitled" && model.status !== "unprobed" && model.status !== "listed" && model.status !== "rate_limited") {
        this.emit(run, { type: "warning", message: `Model ${model.providerModelId} last probed as ${model.status}; trying anyway` });
      }
      mkdirSync(session.workspace, { recursive: true });
      const tools = toolsFor(agent.tools);
      const history = projectMessages(sessions.sessionEvents(session.id));

      this.emit(run, {
        type: "run_started",
        agent: { slug: agent.slug, version: agent.version },
        model: { connectionId: connection.id, modelId: model.providerModelId, dialect: model.dialect },
      });

      const gen = runNativeEngine({
        agent,
        model,
        adapter: adapterFor(model.dialect),
        connection: adapterConnection(this.app, connection, model),
        history,
        userTurn: input,
        tools,
        policy: policyForAgent(agent, tools),
        workspace: session.workspace,
        signal: controller.signal,
        skills: this.app.skills.list(),
        host: createHost(this.app),
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
      if (session.title === "New session") sessions.touchSession(session.id, input.slice(0, 60));
      else sessions.touchSession(session.id);
    } catch (e) {
      const message = (e as Error).message;
      this.emit(run, { type: "run_failed", error: { kind: "unknown", message, retryable: false }, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 });
      sessions.updateRun(run.id, { status: "failed", endedAt: nowIso(), error: message });
    } finally {
      this.active.delete(run.id);
      this.pump();
    }
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

  subscribe(key: `session:${string}` | `run:${string}`, fn: (ev: RunEvent) => void): () => void {
    this.bus.on(key, fn);
    return () => this.bus.off(key, fn);
  }
}
