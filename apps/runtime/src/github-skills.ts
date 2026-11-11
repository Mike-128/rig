import { isParseError, parseSkillMarkdown } from "@rig/core";

/**
 * Installing skills straight from GitHub. A repository can hold one skill (SKILL.md at the root or
 * at the given path) or many (anthropics/skills keeps one per folder); every folder under the
 * requested path that contains a SKILL.md is a skill.
 */

export interface GitHubRef {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
}

export interface RemoteSkill {
  name: string;
  description: string;
  /** Folder of the skill within the repository. */
  path: string;
  files: string[];
  /** Why it cannot be installed, if it cannot. */
  error?: string;
}

export interface RemotePreview {
  repo: string;
  ref: string;
  sha: string;
  path: string;
  skills: RemoteSkill[];
}

export interface FetchedSkill {
  name: string;
  path: string;
  files: { rel: string; data: Buffer }[];
}

const MAX_SKILLS = 100;
const MAX_FILES_PER_SKILL = 300;
const MAX_FILE_BYTES = 5_000_000;
const MAX_SKILL_BYTES = 25_000_000;

/**
 * Accepts the forms people paste: a repo URL, a tree or blob URL into it, or owner/repo[/path][@ref].
 */
export function parseGitHubSource(input: string): GitHubRef {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?/i);
  if (url) {
    const [, owner, repo, kind, ref, rest = ""] = url;
    let p = rest;
    if (kind === "blob" && /(^|\/)SKILL\.md$/i.test(p)) p = p.replace(/\/?SKILL\.md$/i, "");
    return { owner, repo, ref, path: decodeURIComponent(p) };
  }
  const short = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[^@]+)?)(?:@(.+))?$/);
  if (short) {
    const [, owner, repo, p = "", ref] = short;
    return { owner, repo, ref, path: p.replace(/^\//, "") };
  }
  throw new Error(`Not a GitHub repository: "${input}". Use https://github.com/owner/repo, a link to a folder in it, or owner/repo/path.`);
}

export class GitHubSkillSource {
  constructor(private token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN, private fetchImpl: typeof fetch = fetch) {}

  private async api<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "rig-skills",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (res.status === 404) throw new Error("Repository or path not found on GitHub (private repositories need GITHUB_TOKEN set for the runtime).");
    if (res.status === 403 || res.status === 429) {
      throw new Error("GitHub rate limit reached. Set GITHUB_TOKEN for the runtime to raise it, or try again later.");
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  private async raw(ref: GitHubRef, sha: string, file: string): Promise<Buffer> {
    const res = await this.fetchImpl(`https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${sha}/${file.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { "user-agent": "rig-skills", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
    });
    if (!res.ok) throw new Error(`Could not download ${file} (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Lists the repository once and finds every skill under the requested path. */
  private async scan(src: GitHubRef) {
    const repoInfo = await this.api<{ default_branch: string; full_name: string }>(`/repos/${src.owner}/${src.repo}`);
    const ref = src.ref ?? repoInfo.default_branch;
    const commit = await this.api<{ sha: string }>(`/repos/${src.owner}/${src.repo}/commits/${encodeURIComponent(ref)}`);
    const tree = await this.api<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(
      `/repos/${src.owner}/${src.repo}/git/trees/${commit.sha}?recursive=1`,
    );
    const base = src.path.replace(/^\/+|\/+$/g, "");
    const under = (p: string) => !base || p === base || p.startsWith(`${base}/`);
    const blobs = tree.tree.filter((e) => e.type === "blob" && under(e.path));
    const skillDirs = blobs
      .filter((e) => /(^|\/)SKILL\.md$/.test(e.path))
      .map((e) => e.path.replace(/\/?SKILL\.md$/, ""))
      // A skill's own subfolders can hold example SKILL.md files; the outermost one is the skill.
      .filter((d, _i, all) => !all.some((o) => o !== d && (o === "" || d.startsWith(`${o}/`))))
      .slice(0, MAX_SKILLS);
    return { repo: repoInfo.full_name, ref, sha: commit.sha, base, blobs, skillDirs, truncated: tree.truncated };
  }

  async preview(input: string): Promise<RemotePreview> {
    const src = parseGitHubSource(input);
    const scan = await this.scan(src);
    if (!scan.skillDirs.length) {
      throw new Error(`No SKILL.md found in ${scan.repo}${scan.base ? `/${scan.base}` : ""}${scan.truncated ? " (the repository is too large to list fully; link to the skill's folder)" : ""}.`);
    }
    const skills: RemoteSkill[] = [];
    for (const dir of scan.skillDirs) {
      const files = this.filesOf(scan.blobs, dir);
      const md = (await this.raw(src, scan.sha, dir ? `${dir}/SKILL.md` : "SKILL.md")).toString("utf8");
      const parsed = parseSkillMarkdown(md);
      if (isParseError(parsed)) skills.push({ name: dir.split("/").pop() || src.repo, description: "", path: dir, files, error: parsed.error });
      else skills.push({ name: parsed.name, description: parsed.description, path: dir, files, error: tooBig(scan.blobs, dir) });
    }
    return { repo: scan.repo, ref: scan.ref, sha: scan.sha, path: scan.base, skills };
  }

  /** Downloads the named skills (all of them when names is omitted). */
  async fetchSkills(input: string, names?: string[]): Promise<{ preview: RemotePreview; skills: FetchedSkill[] }> {
    const src = parseGitHubSource(input);
    const preview = await this.preview(input);
    const wanted = preview.skills.filter((s) => !s.error && (!names?.length || names.includes(s.name)));
    if (!wanted.length) throw new Error(names?.length ? `None of ${names.join(", ")} found in ${preview.repo}.` : "No installable skills found.");
    const out: FetchedSkill[] = [];
    for (const s of wanted) {
      const files: FetchedSkill["files"] = [];
      for (const rel of s.files) files.push({ rel, data: await this.raw(src, preview.sha, s.path ? `${s.path}/${rel}` : rel) });
      out.push({ name: s.name, path: s.path, files });
    }
    return { preview, skills: out };
  }

  private filesOf(blobs: { path: string; size?: number }[], dir: string): string[] {
    return blobs
      .filter((b) => (dir ? b.path.startsWith(`${dir}/`) : true))
      .map((b) => (dir ? b.path.slice(dir.length + 1) : b.path))
      .filter((rel) => !rel.split("/").some((seg) => seg.startsWith(".git")))
      .slice(0, MAX_FILES_PER_SKILL);
  }
}

function tooBig(blobs: { path: string; size?: number }[], dir: string): string | undefined {
  const mine = blobs.filter((b) => (dir ? b.path.startsWith(`${dir}/`) : true));
  if (mine.length > MAX_FILES_PER_SKILL) return `has more than ${MAX_FILES_PER_SKILL} files`;
  if (mine.some((b) => (b.size ?? 0) > MAX_FILE_BYTES)) return "contains a file over 5 MB";
  if (mine.reduce((n, b) => n + (b.size ?? 0), 0) > MAX_SKILL_BYTES) return "is over 25 MB in total";
  return undefined;
}
