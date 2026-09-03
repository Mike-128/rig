import { spawn } from "node:child_process";
import type { ToolSpec } from "../types";

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_MS = 60_000;

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
      "Run a shell command in the workspace directory and return stdout and stderr. PowerShell on Windows, bash elsewhere. Commands time out after 60 seconds by default. Output is truncated.",
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
    const timeoutMs = Math.min(Math.max((timeoutSeconds ?? 60) * 1000, 1000), 600_000) || DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      const isWin = process.platform === "win32";
      const child = isWin
        ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: ctx.workspace, windowsHide: true })
        : spawn("bash", ["-lc", command], { cwd: ctx.workspace, detached: true });
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
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => finish({ output: `Failed to start: ${e.message}`, isError: true }));
      child.on("close", (code) => {
        const combined = [out.trimEnd(), err.trim() ? `[stderr]\n${err.trimEnd()}` : ""].filter(Boolean).join("\n");
        finish({ output: truncate(`${combined || "(no output)"}\n[exit code ${code ?? "?"}]`), isError: (code ?? 1) !== 0 });
      });
    });
  },
};

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n[truncated: ${s.length - MAX_OUTPUT} more characters]` : s;
}
