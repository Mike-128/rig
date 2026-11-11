import { spawn } from "node:child_process";
import type { ToolSpec } from "../types";
import { detectShell, shellArgs } from "../shell-detect";

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function killTree(pid: number) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export const shellTool: ToolSpec = {
  definition: {
    name: "shell",
    description:
      "Run a shell command in the workspace directory and return stdout, stderr, and the exit code. The shell is named in your environment notes (bash, or PowerShell on Windows without Git Bash). Each call starts a fresh shell in the workspace root, so chain dependent steps in one command. Times out after 120 seconds unless timeoutSeconds says otherwise (max 600). Output streams to the user as it runs and is truncated to the last part if long. Prefer file_read, glob, grep, and file_edit over shell equivalents (cat, find, grep, sed).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run." },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: 600, description: "Optional timeout in seconds." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  sideEffect: true,
  minSandbox: 1,
  run(input, ctx) {
    const { command, timeoutSeconds } = (input ?? {}) as { command?: string; timeoutSeconds?: number };
    if (typeof command !== "string" || !command.trim()) return Promise.resolve({ output: "command is required", isError: true });
    const timeoutMs = timeoutSeconds ? Math.min(Math.max(timeoutSeconds * 1000, 1000), 600_000) : DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      const shell = detectShell();
      // Detached on POSIX so the whole process group can be killed; Windows uses taskkill /T instead.
      const child = spawn(shell.path, shellArgs(shell, command), { cwd: ctx.workspace, windowsHide: true, detached: process.platform !== "win32" });
      let out = "";
      let err = "";
      let done = false;
      const finish = (result: { output: string; isError?: boolean }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        if (child.pid) killTree(child.pid);
        finish({ output: "Cancelled", isError: true });
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        if (child.pid) killTree(child.pid);
        finish({ output: truncate(`${out}\n${err}\n[timed out after ${timeoutMs / 1000}s]`), isError: true });
      }, timeoutMs);
      child.stdout.on("data", (d) => {
        const t = d.toString();
        out += t;
        ctx.onProgress?.(t);
      });
      child.stderr.on("data", (d) => {
        const t = d.toString();
        err += t;
        ctx.onProgress?.(t);
      });
      child.on("error", (e) => finish({ output: `Failed to start: ${e.message}`, isError: true }));
      child.on("close", (code) => {
        const combined = [out.trimEnd(), err.trim() ? `[stderr]\n${err.trimEnd()}` : ""].filter(Boolean).join("\n");
        finish({ output: truncate(`${combined || "(no output)"}\n[exit code ${code ?? "?"}]`), isError: (code ?? 1) !== 0 });
      });
    });
  },
};

/** Keeps the head and the tail: errors and summaries are usually at the end of build and test output. */
function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const head = s.slice(0, MAX_OUTPUT / 4);
  const tail = s.slice(-(MAX_OUTPUT * 3) / 4);
  return `${head}\n[... ${s.length - MAX_OUTPUT} characters omitted ...]\n${tail}`;
}
