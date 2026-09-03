import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayProfile, RunEvent, Session, SkillSummary } from "@harness/core";
import { startServer, type RunningServer } from "../src/server";
import { GOOD_KEY, startMockUpstream } from "./mock-upstream";

/**
 * Skills reaching the model, and conversational agent creation through the agent_write tool.
 */

let home: string;
let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
let rt: RunningServer;

const api = async <T>(p: string, init?: RequestInit & { json?: unknown }): Promise<T> => {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  let body = init?.body;
  if (init?.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`http://127.0.0.1:${rt.port}/api${p}`, { ...init, headers, body });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${p}: ${res.status} ${JSON.stringify(data)}`);
  return data as T;
};

async function waitForRun(runId: string, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await api<{ status: string; pendingApprovals: string[] }>(`/runs/${runId}`);
    if (["completed", "failed", "cancelled", "awaiting_approval"].includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("run did not settle");
}

/** Drive a run to completion, approving every gated call. */
async function runToEnd(sessionId: string, input: string) {
  const run = await api<{ id: string }>(`/sessions/${sessionId}/runs`, { method: "POST", json: { input } });
  let state = await waitForRun(run.id);
  while (state.status === "awaiting_approval") {
    for (const callId of state.pendingApprovals) {
      await api(`/runs/${run.id}/approvals/${callId}`, { method: "POST", json: { decision: "approve" } });
    }
    state = await waitForRun(run.id);
  }
  return { runId: run.id, state };
}

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "harness-skills-"));
  upstream = await startMockUpstream();
  const profile: GatewayProfile = {
    id: "mock-gateway",
    displayName: "Mock gateway",
    baseUrl: upstream.url,
    auth: { headerName: "x-api-key" },
    models: [{ id: "mock-claude", dialect: "anthropic.messages", route: "/v1/messages", pricing: { input: 1, output: 2 } }],
  };
  mkdirSync(path.join(home, "profiles"), { recursive: true });
  writeFileSync(path.join(home, "profiles", "mock.json"), JSON.stringify(profile));
  rt = await startServer({ home, port: 0 }, { fileSecrets: true });

  const conn = await api<{ connection: { id: string } }>("/connections", { method: "POST", json: { name: "mock", profileId: "mock-gateway", key: GOOD_KEY } });
  await api(`/aliases/default`, { method: "PUT", json: { connectionId: conn.connection.id, modelId: "mock-claude" } });
}, 30_000);

afterAll(async () => {
  await rt?.close();
  await upstream?.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows may still hold handles */
  }
});

describe("skills", () => {
  it("ships bundled skills and seeds the agent builder that uses them", async () => {
    const { skills, problems } = await api<{ skills: SkillSummary[]; problems: unknown[] }>("/skills");
    expect(problems).toHaveLength(0);
    expect(skills.map((s) => s.name).sort()).toEqual(["agent-design", "skill-authoring"]);
    expect(skills.every((s) => s.source === "bundled" && s.hash.length === 12)).toBe(true);

    const agents = await api<{ slug: string }[]>("/agents");
    expect(agents.map((a) => a.slug).sort()).toEqual(["agent-builder", "assistant"]);
    const builder = await api<{ skills: string[]; tools: string[]; approvals: string[] }>("/agents/agent-builder");
    expect(builder.skills.sort()).toEqual(["agent-design", "skill-authoring"]);
    expect(builder.tools).toContain("agent_write");
    expect(builder.approvals).toContain("agent_write");
  });

  it("creates a user skill, which shadows a bundled one of the same name", async () => {
    await api("/skills/release-notes", { method: "PUT", json: { description: "House style for release notes.", body: "Past tense. Group by user-visible change." } });
    const after = await api<{ skills: SkillSummary[] }>("/skills");
    expect(after.skills.find((s) => s.name === "release-notes")?.source).toBe("user");

    await api("/skills/agent-design", { method: "PUT", json: { description: "Overridden.", body: "Local house rules." } });
    const shadowed = await api<{ skills: SkillSummary[] }>("/skills");
    const design = shadowed.skills.filter((s) => s.name === "agent-design");
    expect(design).toHaveLength(1);
    expect(design[0].source).toBe("user");

    await api("/skills/agent-design", { method: "DELETE" });
    expect((await api<{ skills: SkillSummary[] }>("/skills")).skills.find((s) => s.name === "agent-design")?.source).toBe("bundled");
  });

  it("rejects a malformed skill and refuses to delete a bundled one", async () => {
    await expect(api("/skills/import", { method: "POST", body: "no frontmatter" })).rejects.toThrow(/400/);
    await expect(api("/skills/skill-authoring", { method: "DELETE" })).rejects.toThrow(/400/);
  });

  it("advertises attached skills in the system prompt and loads the body on demand", async () => {
    await api("/agents/skilled", {
      method: "PUT",
      json: {
        name: "Skilled",
        slug: "skilled",
        model: { alias: "default" },
        instructions: "Follow your skills.",
        tools: ["load_skill"],
        skills: ["agent-design"],
        sandbox: 0,
      },
    });
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "skilled" } });
    const { runId } = await runToEnd(session.id, "use a skill to help me");

    // The first request advertised the skill by name and description, not its body.
    const first = upstream.requests.filter((r) => r.path === "/v1/messages")[0]!;
    const system = String((first.body as { system?: string }).system ?? "");
    expect(system).toContain("Available skills");
    expect(system).toContain("agent-design");
    expect(system).not.toContain("Granting `shell` when `file_read` would do");

    // load_skill returned the full body as a tool result.
    const events = await api<{ events: RunEvent[] }>(`/sessions/${session.id}`).then((d) => d.events);
    const result = events.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(result.name).toBe("load_skill");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("# Skill: agent-design");
    expect(result.output).toContain("Granting `shell` when `file_read` would do");
    expect((await api<{ status: string }>(`/runs/${runId}`)).status).toBe("completed");
  });

  it("refuses to load a skill the agent does not have attached", async () => {
    await api("/agents/skilled", {
      method: "PUT",
      json: {
        name: "Skilled",
        slug: "skilled",
        model: { alias: "default" },
        instructions: "Follow your skills.",
        tools: ["load_skill"],
        skills: ["skill-authoring"],
        sandbox: 0,
      },
    });
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "skilled" } });
    await runToEnd(session.id, "use a skill to help me");
    const events = await api<{ events: RunEvent[] }>(`/sessions/${session.id}`).then((d) => d.events);
    const result = events.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/not enabled for this agent/);
  });
});

describe("conversational agent creation", () => {
  it("creates a working agent from a chat turn, gated by approval", async () => {
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "agent-builder" } });
    const run = await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "build me an agent that takes meeting notes" } });

    // agent_write is approval-gated on the seeded builder, so the run suspends first.
    const waiting = await waitForRun(run.id);
    expect(waiting.status).toBe("awaiting_approval");
    const events = await api<{ events: RunEvent[] }>(`/sessions/${session.id}`).then((d) => d.events);
    const asked = events.find((e) => e.type === "approval_requested") as Extract<RunEvent, { type: "approval_requested" }>;
    expect(asked.name).toBe("agent_write");
    expect((asked.input as { name: string }).name).toBe("Note Taker");

    // Nothing is written until the user approves.
    await expect(api("/agents/note-taker")).rejects.toThrow(/404/);

    await api(`/runs/${run.id}/approvals/${waiting.pendingApprovals[0]}`, { method: "POST", json: { decision: "approve" } });
    expect((await waitForRun(run.id)).status).toBe("completed");

    // The agent now exists, with a slug derived from its name, and is runnable.
    const created = await api<{ slug: string; version: number; tools: string[]; sandbox: number }>("/agents/note-taker");
    expect(created.version).toBe(1);
    expect(created.tools).toEqual(["file_read"]);
    expect(created.sandbox).toBe(0);

    const yaml = await fetch(`http://127.0.0.1:${rt.port}/api/agents/note-taker/export`).then((r) => r.text());
    expect(yaml).toContain("name: Note Taker");

    const newSession = await api<Session>("/sessions", { method: "POST", json: { agent: "note-taker" } });
    const second = await runToEnd(newSession.id, "hello");
    expect(second.state.status).toBe("completed");
  });

  it("reports a denied creation back to the model instead of writing", async () => {
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "agent-builder" } });
    const run = await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "build me an agent that takes meeting notes" } });
    const waiting = await waitForRun(run.id);
    await api(`/runs/${run.id}/approvals/${waiting.pendingApprovals[0]}`, { method: "POST", json: { decision: "deny" } });
    await waitForRun(run.id);
    const events = await api<{ events: RunEvent[] }>(`/sessions/${session.id}`).then((d) => d.events);
    const result = events.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/declined/);
  });

  it("returns validation errors to the model so it can correct them", async () => {
    // A definition that fails the load_skill rule comes back as an error, not a save.
    const bad = await api<{ ok: boolean; issues: { message: string }[] }>("/agents/validate", {
      method: "POST",
      json: { name: "Broken", slug: "broken", model: { alias: "default" }, instructions: "i", skills: ["agent-design"], tools: [] },
    });
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => /load_skill/.test(i.message))).toBe(true);
  });
});

describe("default alias selection", () => {
  it("prefers a generally available chat model over a preview one", async () => {
    // Preview models carry much tighter quota, so auto-binding one makes the seeded agents fail
    // with 429s on their first real use.
    const conn = await api<{ connection: { id: string } }>("/connections", { method: "POST", json: { name: "picks", profileId: "mock-gateway", key: GOOD_KEY } });
    const id = conn.connection.id;
    for (const m of [
      { id: "mock-embed-002", dialect: "openai.chat", route: "/v1/chat/completions" },
      { id: "mock-flash-preview", dialect: "openai.chat", route: "/v1/chat/completions" },
      { id: "mock-flash", dialect: "openai.chat", route: "/v1/chat/completions" },
    ]) {
      await api(`/connections/${id}/models`, { method: "POST", json: m });
    }
    await api("/aliases/default", { method: "DELETE" });
    const res = await api<{ boundDefault?: { modelId: string } }>(`/connections/${id}/probe`, { method: "POST" });
    expect(res.boundDefault?.modelId).toBe("mock-claude");

    // With only the manual models entitled, the stable one wins over preview, and embeddings are skipped.
    await api(`/aliases/default`, { method: "DELETE" });
    await api(`/models/${id}/mock-claude`, { method: "DELETE" });
    const second = await api<{ boundDefault?: { modelId: string } }>(`/connections/${id}/probe`, { method: "POST" });
    expect(second.boundDefault?.modelId).toBe("mock-flash");
  });
});
