import { createHash } from "node:crypto";
import http from "node:http";

/**
 * A small GitHub REST API for tests: one repository with an in-memory git object store, the
 * endpoints Rig's team sync and pull-request flow use, and helpers to review and merge as a
 * teammate would. Trees are stored flat (path -> blob), which is all a recursive read needs.
 *
 * Users are EMU-style (login_shortcode). Each token maps to one user.
 */

interface Commit {
  tree: string;
  parents: string[];
  message: string;
}

interface Pull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
  reviews: { user: { login: string }; state: string }[];
}

export interface MockGitHub {
  url: string;
  owner: string;
  repo: string;
  requests: { method: string; path: string; user?: string }[];
  /** Files on a branch, path -> text. */
  files(branch?: string): Record<string, string>;
  pulls: Pull[];
  review(n: number, login: string, state: "APPROVED" | "CHANGES_REQUESTED"): void;
  /** Merges as GitHub does: the PR's changes applied onto the current base branch. */
  merge(n: number): void;
  setProtected(v: boolean): void;
  close(): Promise<void>;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

export async function startMockGitHub(opts: { tokens: Record<string, string>; owner?: string; repo?: string; port?: number }): Promise<MockGitHub> {
  const owner = opts.owner ?? "acme";
  const repo = opts.repo ?? "rig-team";
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Record<string, string>>();
  const commits = new Map<string, Commit>();
  const refs = new Map<string, string>();
  const pulls: Pull[] = [];
  const requests: MockGitHub["requests"] = [];
  let isProtected = true;

  const putBlob = (b: Buffer) => {
    const s = sha(`blob:${b.toString("base64")}`);
    blobs.set(s, b);
    return s;
  };
  const putTree = (t: Record<string, string>) => {
    const s = sha(`tree:${JSON.stringify(Object.entries(t).sort())}`);
    trees.set(s, { ...t });
    return s;
  };
  const putCommit = (c: Commit) => {
    const s = sha(`commit:${JSON.stringify(c)}:${commits.size}`);
    commits.set(s, c);
    return s;
  };
  const treeOf = (branch: string) => {
    const head = refs.get(branch);
    return head ? trees.get(commits.get(head)!.tree)! : {};
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    let body: any = {};
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const login = opts.tokens[token];
    requests.push({ method: req.method!, path: p + url.search, user: login });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    // Demo helpers, standing in for a teammate on github.com: approve or merge a pull request.
    const demo = p.match(/^\/__(approve|merge)\/(\d+)$/);
    if (demo && pulls[Number(demo[2]) - 1]) {
      const n = Number(demo[2]);
      if (demo[1] === "approve") pulls[n - 1].reviews.push({ user: { login: "teammate_demo" }, state: "APPROVED" });
      else mergePull(n);
      return send(200, { ok: true });
    }
    if (!login) return send(401, { message: "Bad credentials" });
    if (p === "/user") return send(200, { login, id: 1, name: login.split("_")[0], email: null });

    const base = `/repos/${owner}/${repo}`;
    if (!p.startsWith(base)) return send(404, { message: "Not Found" });
    const rest = p.slice(base.length);
    const m = (re: RegExp) => rest.match(re);
    let x: RegExpMatchArray | null;

    if (req.method === "GET" && rest === "") return send(200, { name: repo, owner: { login: owner }, default_branch: "main", private: true, permissions: { push: true } });
    if (req.method === "GET" && (x = m(/^\/commits\/(.+)$/))) {
      const head = refs.get(decodeURIComponent(x[1]));
      if (!head) return send(409, { message: "Git Repository is empty." });
      return send(200, { sha: head, commit: { tree: { sha: commits.get(head)!.tree }, message: commits.get(head)!.message } });
    }
    if (req.method === "GET" && (x = m(/^\/branches\/(.+)$/))) return send(200, { name: x[1], protected: isProtected });
    if (req.method === "GET" && (x = m(/^\/git\/trees\/([0-9a-f]+)$/))) {
      const t = trees.get(x[1]);
      if (!t) return send(404, { message: "Not Found" });
      return send(200, { sha: x[1], truncated: false, tree: Object.entries(t).map(([path, s]) => ({ path, type: "blob", mode: "100644", sha: s, size: blobs.get(s)!.length })) });
    }
    if (req.method === "GET" && (x = m(/^\/git\/blobs\/([0-9a-f]+)$/))) {
      const b = blobs.get(x[1]);
      return b ? send(200, { sha: x[1], content: b.toString("base64"), encoding: "base64" }) : send(404, { message: "Not Found" });
    }
    if (req.method === "POST" && rest === "/git/blobs") return send(201, { sha: putBlob(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8")) });
    if (req.method === "POST" && rest === "/git/trees") {
      const t: Record<string, string> = body.base_tree ? { ...trees.get(body.base_tree)! } : {};
      for (const e of body.tree as { path: string; sha?: string | null; content?: string }[]) {
        if (e.sha === null) delete t[e.path];
        else t[e.path] = e.sha ?? putBlob(Buffer.from(e.content ?? ""));
      }
      return send(201, { sha: putTree(t) });
    }
    if (req.method === "POST" && rest === "/git/commits") return send(201, { sha: putCommit({ tree: body.tree, parents: body.parents, message: body.message }) });
    if (req.method === "POST" && rest === "/git/refs") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (refs.has(name)) return send(422, { message: "Reference already exists" });
      refs.set(name, body.sha);
      return send(201, { ref: body.ref });
    }
    if (req.method === "PUT" && (x = m(/^\/contents\/(.+)$/))) {
      const file = decodeURIComponent(x[1]);
      const branch = body.branch ?? "main";
      const current = treeOf(branch);
      if (current[file]) return send(422, { message: '"sha" wasn\'t supplied.' });
      const tree = putTree({ ...current, [file]: putBlob(Buffer.from(body.content, "base64")) });
      const parent = refs.get(branch);
      refs.set(branch, putCommit({ tree, parents: parent ? [parent] : [], message: body.message }));
      return send(201, { content: { path: file } });
    }
    if (req.method === "POST" && rest === "/pulls") {
      if (!refs.has(body.head)) return send(422, { message: "head does not exist" });
      const pr: Pull = { number: pulls.length + 1, title: body.title, body: body.body, head: body.head, base: body.base, state: "open", merged: false, reviews: [] };
      pulls.push(pr);
      return send(201, { number: pr.number, html_url: `https://github.com/${owner}/${repo}/pull/${pr.number}` });
    }
    if (req.method === "GET" && (x = m(/^\/pulls\/(\d+)$/))) {
      const pr = pulls[Number(x[1]) - 1];
      return pr ? send(200, { number: pr.number, state: pr.state, merged: pr.merged }) : send(404, { message: "Not Found" });
    }
    if (req.method === "GET" && (x = m(/^\/pulls\/(\d+)\/reviews$/))) return send(200, pulls[Number(x[1]) - 1]?.reviews ?? []);
    send(404, { message: `no mock for ${req.method} ${p}` });
  });

  function mergePull(n: number): void {
    const pr = pulls[n - 1];
    const head = commits.get(refs.get(pr.head)!)!;
    const before = trees.get(commits.get(head.parents[0])!.tree)!;
    const after = trees.get(head.tree)!;
    const merged = { ...treeOf(pr.base) };
    for (const [p, s] of Object.entries(after)) if (before[p] !== s) merged[p] = s;
    for (const p of Object.keys(before)) if (!(p in after)) delete merged[p];
    refs.set(pr.base, putCommit({ tree: putTree(merged), parents: [refs.get(pr.base)!, refs.get(pr.head)!], message: `Merge pull request #${n}` }));
    pr.state = "closed";
    pr.merged = true;
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    owner,
    repo,
    requests,
    pulls,
    files(branch = "main") {
      return Object.fromEntries(Object.entries(treeOf(branch)).map(([p, s]) => [p, blobs.get(s)!.toString("utf8")]));
    },
    review(n, login, state) {
      pulls[n - 1].reviews.push({ user: { login }, state });
    },
    merge: mergePull,
    setProtected(v) {
      isProtected = v;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
