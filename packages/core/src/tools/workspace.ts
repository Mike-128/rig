import path from "node:path";

/**
 * Resolve a user-supplied path inside the workspace root and refuse escapes.
 * Case-insensitive comparison on Windows.
 */
export function resolveInWorkspace(root: string, p: string): string {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, p);
  const rel = path.relative(absRoot, abs);
  const escapes =
    rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || (process.platform === "win32" && !abs.toLowerCase().startsWith(absRoot.toLowerCase()));
  if (escapes) throw new Error(`Path escapes the workspace: ${p}`);
  return abs;
}
