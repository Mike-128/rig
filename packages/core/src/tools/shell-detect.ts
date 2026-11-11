import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export interface ShellInfo {
  kind: "bash" | "pwsh" | "powershell";
  /** Executable to spawn. */
  path: string;
  /** How the shell is described to the model, including syntax it must know about. */
  label: string;
}

let cached: ShellInfo | undefined;

function onPath(cmd: string): string | undefined {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean)?.trim() : undefined;
}

/** Git for Windows ships bash. C:\Windows\System32\bash.exe is WSL and runs in another filesystem, so it is never used. */
function gitBash(): string | undefined {
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ];
  const git = onPath("git");
  if (git) candidates.push(path.resolve(path.dirname(git), "..", "bin", "bash.exe"));
  return candidates.find((c): c is string => Boolean(c) && existsSync(c!));
}

const BASH_LABEL = "bash";
const GIT_BASH_LABEL = "Git Bash (bash syntax; Windows paths work with forward slashes, e.g. C:/Users/...)";
const PWSH_LABEL = "PowerShell 7";
const POWERSHELL_LABEL = "Windows PowerShell 5.1 (chain commands with ';' — '&&' and '||' are not supported)";

/**
 * The shell the shell tool runs. Models write bash far more reliably than PowerShell, so on Windows
 * Git Bash is preferred when installed, then PowerShell 7, then the built-in Windows PowerShell.
 * RIG_SHELL=bash|pwsh|powershell overrides the choice.
 */
export function detectShell(): ShellInfo {
  if (cached) return cached;
  const want = process.env.RIG_SHELL?.toLowerCase();
  if (process.platform !== "win32") {
    cached = want === "pwsh" && onPath("pwsh") ? { kind: "pwsh", path: "pwsh", label: PWSH_LABEL } : { kind: "bash", path: "bash", label: BASH_LABEL };
    return cached;
  }
  const bash = want === "pwsh" || want === "powershell" ? undefined : gitBash();
  const pwsh = want === "powershell" ? undefined : onPath("pwsh");
  cached = bash
    ? { kind: "bash", path: bash, label: GIT_BASH_LABEL }
    : pwsh
      ? { kind: "pwsh", path: pwsh, label: PWSH_LABEL }
      : { kind: "powershell", path: "powershell.exe", label: POWERSHELL_LABEL };
  return cached;
}

export function shellArgs(shell: ShellInfo, command: string): string[] {
  if (shell.kind === "bash") return process.platform === "win32" ? ["-c", command] : ["-lc", command];
  return ["-NoProfile", "-NonInteractive", "-Command", command];
}
