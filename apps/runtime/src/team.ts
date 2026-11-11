import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { GitHubError, type GitHubAuth, type GitHubClient } from "./github";

/**
 * The team repo: a GitHub repository the team shares agents, skills, and memory through.
 *
 * Reading: Rig keeps a copy of the allowed files from the default branch under ~/.rig/team/repo,
 * synced over the REST API. Writing: nothing is ever pushed to that branch. Changes collect in a
 * local queue, and "open pull request" turns them into a branch, a commit, and a pull request, so
 * the repository's own reviews, CODEOWNERS, and branch protection decide what the team gets.
 *
 * The repo holds definitions, not deliverables. Only these paths are read or written, with size
 * limits, and agents have no tool that writes anything else into it.
 */
export const TEAM_PATHS = /^(rig-team\.json|README\.md|agents\/[a-z0-9][a-z0-9-]{0,63}\.yaml|memory\/[a-z0-9][a-z0-9-]{0,63}\.md|skills\/[a-z0-9][a-z0-9-]{0,63}\/[^\0]+)$/;
const MAX_FILE_BYTES = 1_000_000;
const MAX_SKILL_BYTES = 5_000_000;
const MAX_SKILL_FILES = 100;

export interface TeamConfig {
  owner: string;
  repo: string;
  branch: string;
}

interface Manifest {
  sha: string;
  syncedAt: string;
  files: Record<string, string>;
}

export type ChangeKind = "agent" | "skill" | "memory";

export interface PendingChange {
  id: string;
  kind: ChangeKind;
  name: string;
  op: "upsert" | "delete";
  /** Repo path -> base64 content, for upserts. */
  files: Record<string, string>;
  summary: string;
  /** Who queued it: the user from the UI, or an agent through memory_write. */
  origin: "user" | "agent";
  createdAt: string;
}

export interface TeamPullRequest {
  number: number;
  url: string;
  title: string;
  branch: string;
  items: { kind: ChangeKind; name: string; op: "upsert" | "delete" }[];
  state: "open" | "merged" | "closed";
  review: "approved" | "changes_requested" | "review_required";
  updatedAt: string;
}

export interface TeamStatus {
  config?: TeamConfig;
  url?: string;
  initialized: boolean;
  syncedSha?: string;
  syncedAt?: string;
  protected?: boolean;
  canPush?: boolean;
  error?: string;
  pending: PendingChange[];
  pullRequests: TeamPullRequest[];
}

type Json = Record<string, any>;

export class TeamManager {
  private dir: string;
  private lastError: string | undefined;
  private repoInfo: { protected?: boolean; canPush?: boolean } = {};
  private syncing: Promise<{ changed: number }> | undefined;

  constructor(
    home: string,
    private auth: GitHubAuth,
  ) {
    this.dir = path.join(home, "team");
    mkdirSync(this.dir, { recursive: true });
  }

  // ---------- local state ----------

  private read<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(path.join(this.dir, file), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private write(file: string, value: unknown): void {
    writeFileSync(path.join(this.dir, file), JSON.stringify(value, null, 2));
  }

  config(): TeamConfig | undefined {
    return this.read<TeamConfig | undefined>("team.json", undefined);
  }

  /** Where synced files live, or undefined when no team repo is connected. */
  repoDir(): string | undefined {
    return this.config() ? path.join(this.dir, "repo") : undefined;
  }

  private manifest(): Manifest | undefined {
    return this.read<Manifest | undefined>("manifest.json", undefined);
  }

  pending(): PendingChange[] {
    return this.read<PendingChange[]>("pending.json", []);
  }

  pullRequests(): TeamPullRequest[] {
    return this.read<TeamPullRequest[]>("prs.json", []);
  }

  status(): TeamStatus {
    const config = this.config();
    const m = this.manifest();
    const host = this.auth.status()?.host ?? "github.com";
    return {
      config,
      url: config ? `https://${host}/${config.owner}/${config.repo}` : undefined,
      initialized: Boolean(m && m.files["rig-team.json"]),
      syncedSha: m?.sha,
      syncedAt: m?.syncedAt,
      protected: this.repoInfo.protected,
      canPush: this.repoInfo.canPush,
      error: this.lastError,
      pending: this.pending(),
      pullRequests: this.pullRequests(),
    };
  }

  // ---------- connecting and syncing ----------

  private repoPath(c: TeamConfig, rest = ""): string {
    return `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}${rest}`;
  }

  /** Points Rig at a repository, checks access, and syncs. An empty repository is fine; it can be set up. */
  async connect(owner: string, repo: string): Promise<TeamStatus> {
    const gh = await this.auth.client();
    const info = await gh.request("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    const config: TeamConfig = { owner: info.owner.login, repo: info.name, branch: info.default_branch ?? "main" };
    if (this.config()?.repo !== config.repo || this.config()?.owner !== config.owner) {
      rmSync(path.join(this.dir, "repo"), { recursive: true, force: true });
      for (const f of ["manifest.json", "pending.json", "prs.json"]) rmSync(path.join(this.dir, f), { force: true });
    }
    this.write("team.json", config);
    this.repoInfo = { canPush: Boolean(info.permissions?.push) };
    await this.sync();
    return this.status();
  }

  disconnect(): void {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.repoInfo = {};
    this.lastError = undefined;
  }

  /** Brings the local copy up to the default branch. Concurrent calls share one sync. */
  sync(): Promise<{ changed: number }> {
    this.syncing ??= this.doSync().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  private async doSync(): Promise<{ changed: number }> {
    const c = this.config();
    if (!c) return { changed: 0 };
    try {
      const gh = await this.auth.client();
      await this.refreshPullRequests(gh, c);
      let head: Json;
      try {
        head = await gh.request("GET", this.repoPath(c, `/commits/${encodeURIComponent(c.branch)}`));
      } catch (e) {
        // A brand-new repository has no commits yet; "set up" creates the first one.
        if (e instanceof GitHubError && (e.status === 409 || e.status === 404)) {
          this.lastError = undefined;
          return { changed: 0 };
        }
        throw e;
      }
      try {
        const b = await gh.request("GET", this.repoPath(c, `/branches/${encodeURIComponent(c.branch)}`));
        this.repoInfo.protected = Boolean(b.protected);
      } catch {
        /* branch details need extra permission on some plans; leave unknown */
      }
      const prev = this.manifest();
      if (prev?.sha === head.sha) {
        this.lastError = undefined;
        return { changed: 0 };
      }
      const tree = await gh.request("GET", this.repoPath(c, `/git/trees/${head.commit.tree.sha}?recursive=1`));
      const blobs = (tree.tree as { path: string; type: string; sha: string; size?: number }[]).filter(
        (e) => e.type === "blob" && TEAM_PATHS.test(e.path) && (e.size ?? 0) <= MAX_FILE_BYTES,
      );
      const root = path.join(this.dir, "repo");
      const files: Record<string, string> = {};
      let changed = 0;
      for (const b of blobs) {
        files[b.path] = b.sha;
        const abs = path.join(root, ...b.path.split("/"));
        if (prev?.files[b.path] === b.sha && existsSync(abs)) continue;
        const blob = await gh.request("GET", this.repoPath(c, `/git/blobs/${b.sha}`));
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, Buffer.from(String(blob.content), (blob.encoding as BufferEncoding) ?? "base64"));
        changed++;
      }
      for (const p of Object.keys(prev?.files ?? {})) {
        if (!files[p]) {
          rmSync(path.join(root, ...p.split("/")), { force: true });
          changed++;
        }
      }
      pruneEmptyDirs(root);
      this.write("manifest.json", { sha: head.sha, syncedAt: new Date().toISOString(), files } satisfies Manifest);
      this.lastError = undefined;
      return { changed };
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  /** First commit into an empty repository: the marker file and a README explaining the layout. */
  async initialize(): Promise<TeamStatus> {
    const c = this.config();
    if (!c) throw new Error("Connect a team repository first.");
    const gh = await this.auth.client();
    const put = (file: string, text: string) =>
      gh.request("PUT", this.repoPath(c, `/contents/${file}`), { message: `Set up ${file} for Rig`, content: Buffer.from(text).toString("base64"), branch: c.branch });
    try {
      await put("rig-team.json", `${JSON.stringify({ rig: 1, layout: { agents: "agents/<slug>.yaml", skills: "skills/<name>/SKILL.md", memory: "memory/<name>.md" } }, null, 2)}\n`);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) {
        throw new Error("The repository already has content. Ask a teammate who set it up, or add rig-team.json through a pull request.");
      }
      throw e;
    }
    await put("README.md", TEAM_README);
    await this.sync();
    return this.status();
  }

  // ---------- proposing changes ----------

  /** Queues a change; a newer change to the same item replaces the queued one. */
  stage(change: Omit<PendingChange, "id" | "createdAt">): PendingChange {
    for (const [p, b64] of Object.entries(change.files)) {
      if (!TEAM_PATHS.test(p)) throw new Error(`${p} is not something the team repo holds (agents, skills, and memory only).`);
      if (Buffer.from(b64, "base64").length > MAX_FILE_BYTES) throw new Error(`${p} is over 1 MB; the team repo holds definitions, not files.`);
    }
    const full: PendingChange = { ...change, id: randomBytes(6).toString("hex"), createdAt: new Date().toISOString() };
    const rest = this.pending().filter((p) => !(p.kind === change.kind && p.name === change.name));
    this.write("pending.json", [...rest, full]);
    return full;
  }

  unstage(id: string): boolean {
    const all = this.pending();
    const next = all.filter((p) => p.id !== id);
    this.write("pending.json", next);
    return next.length !== all.length;
  }

  /** The files a skill folder would contribute, read from disk with the repo's limits applied. */
  static skillFiles(name: string, dir: string): Record<string, string> {
    const files: Record<string, string> = {};
    let total = 0;
    const walk = (d: string, rel: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(d, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(abs, r);
        else {
          const size = statSync(abs).size;
          total += size;
          if (size > MAX_FILE_BYTES) throw new Error(`${r} is over 1 MB; keep large files out of shared skills.`);
          if (Object.keys(files).length >= MAX_SKILL_FILES) throw new Error(`skill "${name}" has more than ${MAX_SKILL_FILES} files`);
          files[`skills/${name}/${r}`] = readFileSync(abs).toString("base64");
        }
      }
    };
    walk(dir, "");
    if (total > MAX_SKILL_BYTES) throw new Error(`skill "${name}" is over 5 MB in total`);
    if (!files[`skills/${name}/SKILL.md`]) throw new Error(`skill "${name}" has no SKILL.md`);
    return files;
  }

  /**
   * Turns queued changes into one pull request: a branch off the default branch, one commit, and the
   * PR. Nothing touches the default branch; the repository's review rules take it from there.
   */
  async openPullRequest(opts: { ids?: string[]; title?: string; body?: string } = {}): Promise<TeamPullRequest> {
    const c = this.config();
    if (!c) throw new Error("Connect a team repository first.");
    const queued = this.pending().filter((p) => !opts.ids?.length || opts.ids.includes(p.id));
    if (!queued.length) throw new Error("Nothing is waiting to be proposed.");
    const gh = await this.auth.client();
    const me = this.auth.status()!;
    await this.sync();
    const known = this.manifest()?.files ?? {};
    const head = await gh.request("GET", this.repoPath(c, `/commits/${encodeURIComponent(c.branch)}`));

    const entries: Json[] = [];
    for (const ch of queued) {
      const prefix = ch.kind === "skill" ? `skills/${ch.name}/` : undefined;
      const owned = prefix ? Object.keys(known).filter((p) => p.startsWith(prefix)) : ch.kind === "agent" ? [`agents/${ch.name}.yaml`] : [`memory/${ch.name}.md`];
      if (ch.op === "delete") {
        for (const p of owned) if (known[p]) entries.push({ path: p, mode: "100644", type: "blob", sha: null });
        continue;
      }
      for (const [p, b64] of Object.entries(ch.files)) {
        const blob = await gh.request("POST", this.repoPath(c, "/git/blobs"), { content: b64, encoding: "base64" });
        entries.push({ path: p, mode: "100644", type: "blob", sha: blob.sha });
      }
      // A skill's files that the new version no longer has are removed with it.
      for (const p of owned) if (known[p] && !ch.files[p]) entries.push({ path: p, mode: "100644", type: "blob", sha: null });
    }
    if (!entries.length) throw new Error("These changes are already on the team repo.");

    const items = queued.map((q) => ({ kind: q.kind, name: q.name, op: q.op }));
    const title = opts.title?.trim() || defaultTitle(items);
    const tree = await gh.request("POST", this.repoPath(c, "/git/trees"), { base_tree: head.commit.tree.sha, tree: entries });
    const commit = await gh.request("POST", this.repoPath(c, "/git/commits"), {
      message: `${title}\n\n${queued.map((q) => `- ${q.summary}`).join("\n")}\n\nProposed from Rig by @${me.login}.`,
      tree: tree.sha,
      parents: [head.sha],
    });
    const branch = `rig/${me.login.replace(/[^A-Za-z0-9._-]/g, "-")}/${stamp()}`;
    await gh.request("POST", this.repoPath(c, "/git/refs"), { ref: `refs/heads/${branch}`, sha: commit.sha });
    const pr = await gh.request("POST", this.repoPath(c, "/pulls"), {
      title,
      head: branch,
      base: c.branch,
      body: prBody(queued, opts.body, me.login),
    });

    const record: TeamPullRequest = { number: pr.number, url: pr.html_url, title, branch, items, state: "open", review: "review_required", updatedAt: new Date().toISOString() };
    this.write("prs.json", [record, ...this.pullRequests()].slice(0, 50));
    const sent = new Set(queued.map((q) => q.id));
    this.write("pending.json", this.pending().filter((p) => !sent.has(p.id)));
    return record;
  }

  /** Updates review and merge state of the pull requests Rig opened; a merge triggers the next sync. */
  private async refreshPullRequests(gh: GitHubClient, c: TeamConfig): Promise<void> {
    const prs = this.pullRequests();
    let touched = false;
    for (const pr of prs) {
      if (pr.state !== "open") continue;
      try {
        const p = await gh.request("GET", this.repoPath(c, `/pulls/${pr.number}`));
        const reviews = (await gh.request<Json[]>("GET", this.repoPath(c, `/pulls/${pr.number}/reviews`))) as unknown as Json[];
        const latest = new Map<string, string>();
        for (const r of reviews) if (r.state !== "COMMENTED") latest.set(String(r.user?.login), String(r.state));
        const states = [...latest.values()];
        pr.state = p.merged ? "merged" : p.state === "closed" ? "closed" : "open";
        pr.review = states.includes("CHANGES_REQUESTED") ? "changes_requested" : states.includes("APPROVED") ? "approved" : "review_required";
        pr.updatedAt = new Date().toISOString();
        touched = true;
      } catch {
        /* keep the last known state */
      }
    }
    if (touched) this.write("prs.json", prs);
  }
}

function defaultTitle(items: { kind: ChangeKind; name: string; op: string }[]): string {
  if (items.length === 1) {
    const i = items[0];
    return `${i.op === "delete" ? "Remove" : "Share"} ${i.kind} ${i.name}`;
  }
  const counts = (["agent", "skill", "memory"] as const).map((k) => [k, items.filter((i) => i.kind === k).length] as const).filter(([, n]) => n);
  return `Update ${counts.map(([k, n]) => `${n} ${k}${n === 1 ? "" : k === "memory" ? "" : "s"}`).join(", ")}`;
}

function prBody(changes: PendingChange[], note: string | undefined, login: string): string {
  const lines = changes.map((c) => `- **${c.op === "delete" ? "Remove" : "Add or update"} ${c.kind} \`${c.name}\`**: ${c.summary}${c.origin === "agent" ? " _(written by an agent)_" : ""}`);
  return [
    note?.trim(),
    "### Changes",
    ...lines,
    "",
    "Merging shares these with everyone on the team: Rig picks them up on its next sync. Review agent instructions and memories as carefully as code, since they steer every teammate's agents.",
    "",
    `_Proposed from Rig by @${login}._`,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-") + `-${randomBytes(2).toString("hex")}`;
}

function pruneEmptyDirs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    pruneEmptyDirs(sub);
    if (!readdirSync(sub).length) rmSync(sub, { recursive: true, force: true });
  }
}

const TEAM_README = `# Rig team repository

This repository shares Rig agents, skills, and memory across the team. Rig reads it from the default
branch and proposes every change as a pull request, so reviews decide what the team's agents get.

| Folder | Holds |
|---|---|
| \`agents/<slug>.yaml\` | Agent definitions. They bind to model aliases such as \`default\`, which each person maps to a model on their own machine. |
| \`skills/<name>/SKILL.md\` | Skills, with any scripts or reference files they need. |
| \`memory/<name>.md\` | Team memory: one short fact, decision, convention, or gotcha per file. |

This is not a place for deliverables or data: Rig only reads and writes the paths above, with size
limits. Keep reports and outputs where your team keeps documents.

**Recommended settings:** protect the default branch and require a pull request review before
merging (Settings → Branches). A CODEOWNERS file can route agent and memory changes to specific
reviewers.
`;
