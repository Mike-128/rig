import { open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentDefinition } from "@rig/core";

const MAX_BYTES = 1_048_576;
const PAGE_CHARS = 20_000;
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".sql", ".sh", ".ps1", ".toml", ".ini", ".log", ".rst"]);

function assertWithin(root: string, candidate: string) {
  const rel = path.relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Path escapes the configured knowledge folder");
}

async function sourcePath(sources: AgentDefinition["knowledge"], name: string, file: string) {
  const source = sources?.find((s) => s.name === name);
  if (!source) throw new Error("Unknown knowledge source for this agent");
  if (!path.isAbsolute(source.path)) throw new Error("This source path is not absolute on the runtime's operating system");
  if (path.win32.isAbsolute(file) || path.posix.isAbsolute(file) || file.includes(":") || file.includes("\0")) throw new Error("Use a relative knowledge path without drive or stream syntax");
  const root = await realpath(source.path);
  if (!(await stat(root)).isDirectory()) throw new Error("Knowledge source must be a directory");
  const lexical = path.resolve(root, file.replaceAll("\\", "/"));
  assertWithin(root, lexical);
  const target = await realpath(lexical);
  assertWithin(root, target);
  return { root, target };
}

async function textFile(file: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) && path.extname(file)) throw new Error("Unsupported file format. Export PDF, Office and other binary documents to UTF-8 text or Markdown first.");
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Not a regular file");
    if (info.size > MAX_BYTES) throw new Error("File exceeds the 1 MiB text limit; split it into smaller documents");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_BYTES) throw new Error("File exceeds the 1 MiB text limit");
    const data = bytes.subarray(0, total);
    if (data.includes(0)) throw new Error("Binary or UTF-16 file: export as UTF-8 text first");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
    catch { throw new Error("File is not valid UTF-8 text"); }
  } finally { await handle.close(); }
}

/** Bound waiting on unavailable network shares; pending OS I/O is not forcibly terminated. */
export async function knowledgeOperation<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  deadline.throwIfAborted();
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Knowledge operation cancelled or timed out; check the share and runtime permissions"));
    deadline.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work(deadline), interrupted]); }
  finally { deadline.removeEventListener("abort", abort); }
}

export async function readKnowledge(sources: AgentDefinition["knowledge"], source: string, file: string, offset: number, signal: AbortSignal) {
  return knowledgeOperation(signal, async (active) => {
    const { target } = await sourcePath(sources, source, file);
    active.throwIfAborted();
    if ((await stat(target)).isDirectory()) {
      const entries: { name: string; kind: string }[] = [];
      let truncated = false;
      const dir = await opendir(target);
      for await (const entry of dir) {
        active.throwIfAborted();
        if (entries.length === 500) { truncated = true; break; }
        entries.push({ name: entry.name, kind: entry.isSymbolicLink() ? "link (not searched)" : entry.isDirectory() ? "directory" : "file" });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return JSON.stringify({ source, path: file, entries, truncated });
    }
    const text = await textFile(target, active);
    return JSON.stringify({ source, path: file, offset, content: text.slice(offset, offset + PAGE_CHARS), nextOffset: offset + PAGE_CHARS < text.length ? offset + PAGE_CHARS : null });
  });
}

export async function searchKnowledge(sources: AgentDefinition["knowledge"], source: string, query: string, signal: AbortSignal) {
  return knowledgeOperation(signal, async (active) => {
    const { root } = await sourcePath(sources, source, ".");
    const hits: { path: string; line: number; excerpt: string }[] = [];
    const queue = [root];
    let examined = 0, files = 0, skipped = 0, bytes = 0;
    const needle = query.toLowerCase();
    while (queue.length && examined < 2000 && files < 100 && hits.length < 50 && bytes < 8 * MAX_BYTES) {
      active.throwIfAborted();
      const folder = queue.shift()!;
      assertWithin(root, await realpath(folder));
      const dir = await opendir(folder);
      for await (const entry of dir) {
        active.throwIfAborted();
        if (++examined > 2000 || files >= 100 || hits.length >= 50 || bytes >= 8 * MAX_BYTES) { queue.push(folder); break; }
        if (entry.isSymbolicLink() || [".git", "node_modules"].includes(entry.name)) { skipped++; continue; }
        const candidate = path.join(folder, entry.name);
        if (entry.isDirectory()) { queue.push(candidate); continue; }
        if (!entry.isFile()) { skipped++; continue; }
        files++;
        try {
          assertWithin(root, await realpath(candidate));
          const text = await textFile(candidate, active);
          bytes += Buffer.byteLength(text);
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < 50; i++) {
            const position = lines[i].toLowerCase().indexOf(needle);
            if (position >= 0) hits.push({ path: path.relative(root, candidate).split(path.sep).join("/"), line: i + 1, excerpt: lines[i].slice(Math.max(0, position - 80), position + 240) });
          }
        } catch { active.throwIfAborted(); skipped++; }
      }
    }
    return JSON.stringify({ source, query, hits, filesExamined: files, skipped, truncated: !!queue.length || hits.length >= 50, limits: "100 files / 2000 entries / 8 MiB / 50 hits; links, .git and node_modules excluded" });
  });
}
