import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentSummary, GatewayProfile, MemorySummary, RunEvent, Session } from "@rig/core";
import { startServer, type RunningServer } from "../src/server";
import { apiBase } from "../src/github";
import type { TeamStatus } from "../src/team";
import { GOOD_KEY, startMockUpstream } from "./mock-upstream";
import { startMockGitHub, type MockGitHub } from "./mock-github";

/**
 * Two teammates, each with their own runtime, home, and model key, sharing one team repo.
 * Alice builds an agent and shares it; the change goes through a pull request; once Bob approves
 * and it merges, Bob runs the agent on his own model. Nothing reaches main without a merge.
 */

const ALICE_TOKEN = "ghu_alice_token_1234";
const BOB_TOKEN = "ghu_bob_token_5678";
let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
let gh: MockGitHub;
const homes: string[] = [];
let alice: RunningServer;
let bob: RunningServer;

function client(rt: () => RunningServer) {
  return async <T>(p: string, init?: RequestInit & { json?: unknown }): Promise<T> => {
    const headers: Record<string, string> = {};
    let body = init?.body;
    if (init?.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    const res = await fetch(`http://127.0.0.1:${rt().port}/api${p}`, { ...init, headers, body });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new Error(`${p}: ${res.status} ${JSON.stringify(data)}`);
    return data as T;
  };
}
const asAlice = client(() => alice);
const asBob = client(() => bob);

async function startPerson(): Promise<RunningServer> {
  const home = mkdtempSync(path.join(os.tmpdir(), "rig-team-"));
  homes.push(home);
  const profile: GatewayProfile = {
    id: "mock-gateway",
    displayName: "Mock gateway",
    baseUrl: upstream.url,
    auth: { headerName: "x-api-key" },
    models: [{ id: "mock-claude", dialect: "anthropic.messages", route: "/v1/messages" }],
  };
  mkdirSync(path.join(home, "profiles"), { recursive: true });
  writeFileSync(path.join(home, "profiles", "mock.json"), JSON.stringify(profile));
  const rt = await startServer({ home, port: 0 }, { fileSecrets: true, github: { apiBase: gh.url } });
  const api = client(() => rt);
  const conn = await api<{ connection: { id: string } }>("/connections", { method: "POST", json: { name: "mock", profileId: "mock-gateway", key: GOOD_KEY } });
  await api(`/aliases/default`, { method: "PUT", json: { connectionId: conn.connection.id, modelId: "mock-claude" } });
  return rt;
}

async function waitForRun(api: typeof asAlice, runId: string) {
  for (let i = 0; i < 200; i++) {
    const r = await api<{ status: string; pendingApprovals: string[] }>(`/runs/${runId}`);
    if (["completed", "failed", "cancelled", "awaiting_approval"].includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error("run did not settle");
}

beforeAll(async () => {
  upstream = await startMockUpstream();
  gh = await startMockGitHub({ tokens: { [ALICE_TOKEN]: "alice_acme", [BOB_TOKEN]: "bob_acme" } });
  alice = await startPerson();
  bob = await startPerson();
}, 30_000);

afterAll(async () => {
  await alice?.close();
  await bob?.close();
  await gh?.close();
  await upstream?.close();
  for (const h of homes) {
    try {
      rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* Windows may hold handles */
    }
  }
});

describe("GitHub hosts", () => {
  it("finds the API for github.com (including EMU), data-residency, and Enterprise Server hosts", () => {
    expect(apiBase("github.com")).toBe("https://api.github.com");
    expect(apiBase("https://acme.ghe.com/")).toBe("https://api.acme.ghe.com");
    expect(apiBase("github.internal.example")).toBe("https://github.internal.example/api/v3");
  });
});

describe("a shared team repo", () => {
  it("signs each person in as themselves and rejects a bad token", async () => {
    await expect(asAlice("/github/token", { method: "POST", json: { host: "github.com", token: "not-a-real-token" } })).rejects.toThrow(/401/);
    expect((await asAlice<{ connection: { login: string } }>("/github/token", { method: "POST", json: { token: ALICE_TOKEN } })).connection.login).toBe("alice_acme");
    expect((await asBob<{ connection: { login: string } }>("/github/token", { method: "POST", json: { token: BOB_TOKEN } })).connection.login).toBe("bob_acme");
    // The token stays in the runtime: the API reports only who is signed in.
    expect(JSON.stringify(await asAlice("/github"))).not.toContain(ALICE_TOKEN);
  });

  it("connects an empty repository and sets it up", async () => {
    const empty = await asAlice<TeamStatus>("/team", { method: "PUT", json: { repo: "https://github.com/acme/rig-team" } });
    expect(empty).toMatchObject({ initialized: false, canPush: true, config: { owner: "acme", repo: "rig-team", branch: "main" } });
    const ready = await asAlice<TeamStatus>("/team/init", { method: "POST" });
    expect(ready.initialized).toBe(true);
    expect(Object.keys(gh.files()).sort()).toEqual(["README.md", "rig-team.json"]);
    expect((await asBob<TeamStatus>("/team", { method: "PUT", json: { repo: "acme/rig-team" } })).initialized).toBe(true);
  });

  it("shares an agent and the personal skill it uses through one pull request, leaving main untouched", async () => {
    await asAlice("/skills/review-checklist", { method: "PUT", json: { description: "How we review pull requests.", body: "Check tests, naming, and error handling." } });
    await asAlice("/agents/reviewer", {
      method: "PUT",
      json: { name: "Reviewer", slug: "reviewer", model: { alias: "default" }, instructions: "Review code.", tools: ["file_read", "load_skill"], skills: ["review-checklist"] },
    });
    const shared = await asAlice<{ staged: { kind: string; name: string }[] }>("/team/share", { method: "POST", json: { kind: "agent", name: "reviewer" } });
    expect(shared.staged.map((s) => `${s.kind}:${s.name}`)).toEqual(["agent:reviewer", "skill:review-checklist"]);

    const { pullRequest } = await asAlice<{ pullRequest: { number: number; branch: string; url: string } }>("/team/pull-request", { method: "POST", json: {} });
    expect(pullRequest.branch).toMatch(/^rig\/alice_acme\//);
    expect(Object.keys(gh.files(pullRequest.branch)).sort()).toEqual(["README.md", "agents/reviewer.yaml", "rig-team.json", "skills/review-checklist/SKILL.md"]);
    expect(Object.keys(gh.files())).not.toContain("agents/reviewer.yaml");
    expect((await asAlice<TeamStatus>("/team")).pending).toEqual([]);
    expect(gh.pulls[0].body).toContain("@alice_acme");

    // Not merged yet: Bob does not have it.
    await asBob("/team/sync", { method: "POST" });
    expect((await asBob<AgentSummary[]>("/agents")).map((a) => a.slug)).not.toContain("reviewer");
  });

  it("tracks review state, and after the merge Bob runs the agent on his own model", async () => {
    gh.review(1, "bob_acme", "APPROVED");
    await asAlice("/team/sync", { method: "POST" });
    expect((await asAlice<TeamStatus>("/team")).pullRequests[0]).toMatchObject({ state: "open", review: "approved" });

    gh.merge(1);
    const synced = await asBob<{ changed: number }>("/team/sync", { method: "POST" });
    expect(synced.changed).toBeGreaterThan(0);
    const reviewer = (await asBob<AgentSummary[]>("/agents")).find((a) => a.slug === "reviewer");
    expect(reviewer).toMatchObject({ source: "team", version: 1 });
    expect((await asBob<{ skills: { name: string; source: string }[] }>("/skills")).skills.find((s) => s.name === "review-checklist")?.source).toBe("team");

    const session = await asBob<Session>("/sessions", { method: "POST", json: { agent: "reviewer" } });
    const run = await asBob<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "hello" } });
    expect((await waitForRun(asBob, run.id)).status).toBe("completed");

    await asAlice("/team/sync", { method: "POST" });
    const mine = (await asAlice<AgentSummary[]>("/agents")).find((a) => a.slug === "reviewer");
    expect(mine).toMatchObject({ source: "local", inTeam: true });
    expect((await asAlice<TeamStatus>("/team")).pullRequests[0].state).toBe("merged");
  });

  it("proposes an edit to a team agent without changing anything locally", async () => {
    const res = await asBob<{ staged: { name: string }[] }>("/team/agents/reviewer", {
      method: "PUT",
      json: { name: "Reviewer", model: { alias: "default" }, instructions: "Review code, strictly.", tools: ["file_read", "load_skill"], skills: ["review-checklist"] },
    });
    expect(res.staged.map((s) => s.name)).toEqual(["reviewer"]);
    const team = await asBob<TeamStatus>("/team");
    expect(team.pending).toHaveLength(1);
    expect(Buffer.from(Object.values(team.pending[0].files)[0], "base64").toString()).toMatch(/version: 2/);
    await asBob(`/team/pending/${team.pending[0].id}`, { method: "DELETE" });
  });

  it("refuses to share an agent bound to one person's connection", async () => {
    const conns = await asAlice<{ name: string }[]>("/connections");
    await asAlice("/agents/pinned", { method: "PUT", json: { name: "Pinned", slug: "pinned", model: { connection: conns[0].name, model: "mock-claude" }, instructions: "x" } });
    await expect(asAlice("/team/share", { method: "POST", json: { kind: "agent", name: "pinned" } })).rejects.toThrow(/alias/);
  });

  it("lets an agent propose team memory, which reaches teammates only after review and merge", async () => {
    await asBob("/agents/coder-2", {
      method: "PUT",
      json: { name: "Coder 2", slug: "coder-2", model: { alias: "default" }, instructions: "x", tools: ["memory_read", "memory_write"] },
    });
    const session = await asBob<Session>("/sessions", { method: "POST", json: { agent: "coder-2" } });
    const run = await asBob<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "remember for the team that the gateway needs the APIM header" } });
    expect((await waitForRun(asBob, run.id)).status).toBe("completed");
    const result = (await asBob<{ events: RunEvent[] }>(`/sessions/${session.id}`)).events.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(result.output).toMatch(/Proposed to the team/);

    const pending = (await asBob<TeamStatus>("/team")).pending;
    expect(pending).toMatchObject([{ kind: "memory", name: "gateway-needs-apim-header", origin: "agent" }]);
    expect((await asAlice<{ memories: MemorySummary[] }>("/memory")).memories).toEqual([]);

    const { pullRequest } = await asBob<{ pullRequest: { number: number } }>("/team/pull-request", { method: "POST", json: { title: "Gateway gotcha" } });
    expect(gh.pulls[pullRequest.number - 1].body).toContain("written by an agent");
    gh.merge(pullRequest.number);
    await asAlice("/team/sync", { method: "POST" });
    const mem = (await asAlice<{ memories: (MemorySummary & { body: string })[] }>("/memory")).memories;
    expect(mem).toMatchObject([{ name: "gateway-needs-apim-header", scope: "team", type: "gotcha", author: "bob_acme" }]);

    // Alice's agents see it in their memory index.
    const s2 = await asAlice<Session>("/sessions", { method: "POST", json: { agent: "coder" } });
    await waitForRun(asAlice, (await asAlice<{ id: string }>(`/sessions/${s2.id}/runs`, { method: "POST", json: { input: "hello" } })).id);
    const system = JSON.stringify((upstream.requests.filter((r) => r.path === "/v1/messages").at(-1)!.body as { system: unknown }).system);
    expect(system).toContain("gateway-needs-apim-header [team gotcha, bob_acme]");
  });

  it("only ever writes agents, skills, and memory into the repo", async () => {
    await expect(asAlice("/memory/team/big-report", { method: "PUT", json: { description: "A report", type: "reference", body: "x".repeat(9000) } })).rejects.toThrow(/short notes/);
    const files = Object.keys(gh.files());
    expect(files.every((f) => /^(README\.md|rig-team\.json|agents\/|skills\/|memory\/)/.test(f))).toBe(true);
    // Every write went to a rig/ branch through a pull request; main moved only by merges.
    const refWrites = gh.requests.filter((r) => r.method === "POST" && r.path.endsWith("/git/refs"));
    expect(refWrites.length).toBe(gh.pulls.length);
  });
});
