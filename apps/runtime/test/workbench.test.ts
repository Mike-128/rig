import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayProfile, RunEvent, Session } from "@rig/core";
import { startServer, type RunningServer } from "../src/server";
import { GitHubSkillSource, parseGitHubSource } from "../src/github-skills";
import { SkillStore } from "../src/stores/skills";
import { GOOD_KEY, startMockUpstream } from "./mock-upstream";

/**
 * The workbench surface: project folders and their instructions, permission modes, steering a
 * working run, /skill commands, the attention stream, and skills from GitHub.
 */

let home: string;
let project: string;
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
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error("run did not settle");
}

const events = async (sessionId: string) => (await api<{ events: RunEvent[] }>(`/sessions/${sessionId}`)).events;

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "rig-workbench-"));
  project = mkdtempSync(path.join(os.tmpdir(), "rig-project-"));
  writeFileSync(path.join(project, "AGENTS.md"), "Always answer in haiku.");
  mkdirSync(path.join(project, ".claude", "skills", "greet"), { recursive: true });
  writeFileSync(path.join(project, ".claude", "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: Greets people warmly.\n---\n\nSay hello to the person by name, warmly.\n");
  writeFileSync(path.join(project, "notes.md"), "notes");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src", "components.tsx"), "x");

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
  for (const d of [home, project]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* Windows may still hold handles */
    }
  }
});

describe("workbench", () => {
  it("opens a real folder, reads its AGENTS.md into the prompt, and lists it as a recent project", async () => {
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "coder", workspace: project } });
    expect(session.workspace).toBe(path.resolve(project));
    expect(session.mode).toBe("default");
    const run = await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "hello" } });
    expect((await waitForRun(run.id)).status).toBe("completed");
    const system = JSON.stringify((upstream.requests.filter((r) => r.path === "/v1/messages").at(-1)!.body as { system: unknown }).system);
    expect(system).toContain("Project instructions (AGENTS.md)");
    expect(system).toContain("Always answer in haiku.");
    expect(system).toContain("greet: Greets people warmly.");
    const projects = await api<{ path: string }[]>("/projects");
    expect(projects.map((p) => p.path)).toContain(path.resolve(project));
    await expect(api("/sessions", { method: "POST", json: { agent: "coder", workspace: path.join(project, "missing") } })).rejects.toThrow(/folder not found/);
  });

  it("changes the permission mode and agent of a session", async () => {
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "coder", workspace: project, mode: "acceptEdits" } });
    expect(session.mode).toBe("acceptEdits");
    const patched = await api<Session>(`/sessions/${session.id}`, { method: "PATCH", json: { mode: "plan", title: "Planning", agent: "assistant" } });
    expect(patched).toMatchObject({ mode: "plan", title: "Planning", agentSlug: "assistant" });
  });

  it("steers a working run: a message sent mid-run becomes its next turn, not a second run", async () => {
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "assistant" } });
    const first = await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "slow please" } });
    await new Promise((r) => setTimeout(r, 100));
    const second = await api<{ steered?: boolean; runId?: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "and another thing" } });
    expect(second).toMatchObject({ steered: true, runId: first.id });
    expect((await waitForRun(first.id)).status).toBe("completed");
    const evs = await events(session.id);
    expect(evs.filter((e) => e.type === "run_started")).toHaveLength(1);
    const replies = evs.filter((e) => e.type === "assistant_message").map((e) => JSON.stringify((e as Extract<RunEvent, { type: "assistant_message" }>).message));
    expect(replies.at(-1)).toContain("You said: and another thing");
  });

  it("expands /skill commands, showing what the user typed", async () => {
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "assistant", workspace: project } });
    const run = await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "/greet Bob" } });
    await waitForRun(run.id);
    const user = (await events(session.id)).find((e) => e.type === "user_message") as Extract<RunEvent, { type: "user_message" }>;
    expect(user.display).toBe("/greet Bob");
    expect(JSON.stringify(user.message)).toContain("Say hello to the person by name, warmly.");
    expect(JSON.stringify(user.message)).toContain("The user's request: Bob");
    expect((await api<Session>(`/sessions/${session.id}`).then(() => api<Session[]>("/sessions"))).find((s) => s.id === session.id)?.title).toBe("/greet Bob");
  });

  it("attaches the contents of @mentioned files, showing what the user typed", async () => {
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "assistant", workspace: project } });
    const run = await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "summarize @notes.md and @missing.txt" } });
    await waitForRun(run.id);
    const user = (await events(session.id)).find((e) => e.type === "user_message") as Extract<RunEvent, { type: "user_message" }>;
    expect(user.display).toBe("summarize @notes.md and @missing.txt");
    const sent = (user.message.content[0] as { text: string }).text;
    expect(sent).toContain('<file path="notes.md">\nnotes\n</file>');
    expect(sent).not.toContain('<file path="missing.txt">');
  });

  it("finds files for @mentions by fuzzy match", async () => {
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "coder", workspace: project } });
    const hits = await api<string[]>(`/sessions/${session.id}/files?q=comp`);
    expect(hits[0]).toBe("src/components.tsx");
    expect(await api<string[]>(`/sessions/${session.id}/files?q=nts.md`)).toContain("notes.md");
  });

  it("streams attention events across sessions", async () => {
    const res = await fetch(`http://127.0.0.1:${rt.port}/api/events`);
    const reader = res.body!.getReader();
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "assistant" } });
    await api(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "hi" } });
    let text = "";
    const t0 = Date.now();
    while (!text.includes("run_completed") && Date.now() - t0 < 5000) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain("event: hello");
    expect(text).toContain("event: run_completed");
    expect(text).toContain(session.id);
  });

  it("compacts a session on request", async () => {
    const session = await api<Session>("/sessions", { method: "POST", json: { agent: "assistant" } });
    await waitForRun((await api<{ id: string }>(`/sessions/${session.id}/runs`, { method: "POST", json: { input: "remember 42" } })).id);
    const run = await api<{ id: string }>(`/sessions/${session.id}/compact`, { method: "POST" });
    expect((await waitForRun(run.id)).status).toBe("completed");
    const detail = await api<{ events: RunEvent[]; messages: unknown[] }>(`/sessions/${session.id}`);
    expect(detail.events.some((e) => e.type === "compacted")).toBe(true);
    expect(detail.messages).toHaveLength(1);
  });
});

describe("skills from GitHub", () => {
  it("parses the forms people paste", () => {
    expect(parseGitHubSource("https://github.com/anthropics/skills")).toEqual({ owner: "anthropics", repo: "skills", ref: undefined, path: "" });
    expect(parseGitHubSource("https://github.com/anthropics/skills/tree/main/skills/pdf")).toEqual({ owner: "anthropics", repo: "skills", ref: "main", path: "skills/pdf" });
    expect(parseGitHubSource("https://github.com/o/r/blob/v2/x/SKILL.md")).toEqual({ owner: "o", repo: "r", ref: "v2", path: "x" });
    expect(parseGitHubSource("o/r/skills/a@dev")).toEqual({ owner: "o", repo: "r", ref: "dev", path: "skills/a" });
    expect(() => parseGitHubSource("not a repo")).toThrow();
  });

  it("previews and installs every skill under a path, with its resources and origin", async () => {
    const files: Record<string, string> = {
      "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: First skill.\n---\n\nDo alpha.\n",
      "skills/alpha/scripts/run.py": "print('alpha')\n",
      "skills/beta/SKILL.md": "---\nname: beta\ndescription: Second skill.\n---\n\nDo beta.\n",
      "skills/beta/examples/inner/SKILL.md": "---\nname: inner\ndescription: An example inside beta.\n---\n\nIgnored as a separate skill.\n",
      "skills/broken/SKILL.md": "no frontmatter",
      "README.md": "repo readme",
    };
    const fakeFetch = (async (url: string) => {
      const u = String(url);
      const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
      if (u.endsWith("/repos/acme/skills")) return json({ default_branch: "main", full_name: "acme/skills" });
      if (u.includes("/commits/main")) return json({ sha: "abc123" });
      if (u.includes("/git/trees/abc123")) return json({ truncated: false, tree: Object.keys(files).map((p) => ({ path: p, type: "blob", size: files[p].length })) });
      const raw = u.match(/raw\.githubusercontent\.com\/acme\/skills\/abc123\/(.+)$/);
      if (raw) return new Response(files[decodeURIComponent(raw[1])]);
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const source = new GitHubSkillSource(undefined, fakeFetch);
    const preview = await source.preview("https://github.com/acme/skills/tree/main/skills");
    expect(preview.skills.map((s) => [s.name, Boolean(s.error)])).toEqual([
      ["alpha", false],
      ["beta", false],
      ["broken", true],
    ]);
    const { skills } = await source.fetchSkills("acme/skills/skills");
    const dir = mkdtempSync(path.join(os.tmpdir(), "rig-ghskills-"));
    try {
      const store = new SkillStore(dir);
      const res = store.installFetched(skills, { repo: "acme/skills", ref: "main", sha: "abc123" });
      expect(res.installed.sort()).toEqual(["alpha", "beta"]);
      expect(readFileSync(path.join(dir, "alpha", "scripts", "run.py"), "utf8")).toContain("alpha");
      expect(existsSync(path.join(dir, "beta", "examples", "inner", "SKILL.md"))).toBe(true);
      const alpha = store.get("alpha")!;
      expect(alpha.origin).toMatchObject({ repo: "acme/skills", sha: "abc123", path: "skills/alpha" });
      expect(alpha.files).toEqual(["scripts/run.py"]);
      expect(store.list().map((s) => s.name)).toEqual(["alpha", "beta"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses files that would land outside the skill's folder", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rig-ghskills-"));
    try {
      const store = new SkillStore(dir);
      const res = store.installFetched(
        [{ name: "evil", path: "evil", files: [{ rel: "SKILL.md", data: Buffer.from("---\nname: evil\ndescription: d\n---\n\nbody") }, { rel: "../escape.txt", data: Buffer.from("x") }] }],
        { repo: "x/y", ref: "main" },
      );
      expect(res.installed).toEqual([]);
      expect(existsSync(path.join(dir, "escape.txt"))).toBe(false);
      expect(existsSync(path.join(dir, "evil"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
