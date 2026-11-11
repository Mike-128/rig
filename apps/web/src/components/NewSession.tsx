import { useEffect, useState } from "react";
import type { AgentSummary, PermissionMode, Session } from "@rig/core/types";
import { api } from "../api";
import { desktop } from "../desktop";

export const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Ask before changes",
  acceptEdits: "Accept edits",
  plan: "Plan only",
  auto: "Auto",
};

export const MODE_HELP: Record<PermissionMode, string> = {
  default: "Asks before editing files or running commands.",
  acceptEdits: "Edits files without asking; still asks before commands.",
  plan: "Read-only. The agent investigates and proposes a plan.",
  auto: "Runs everything it is allowed to without asking.",
};

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

interface Props {
  agents: AgentSummary[];
  /** Pre-filled folder, e.g. the current session's for /clear. */
  folder?: string;
  onCreated(s: Session): void;
  onClose(): void;
}

export function NewSessionDialog({ agents, folder: initialFolder, onCreated, onClose }: Props) {
  const [recent, setRecent] = useState<{ path: string }[]>([]);
  const [folder, setFolder] = useState(initialFolder ?? "");
  const [agent, setAgent] = useState("");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ path: string }[]>("/projects").then(setRecent).catch(() => {});
  }, []);

  // A folder means coding; no folder means a plain chat in a scratch workspace.
  const effectiveAgent = agent || (folder ? (agents.some((a) => a.slug === "coder") ? "coder" : "assistant") : "assistant");

  async function start(path = folder) {
    setBusy(true);
    setError(null);
    try {
      const s = await api<Session>("/sessions", { method: "POST", json: { agent: effectiveAgent, workspace: path.trim() || undefined, mode, kind: path ? "workbench" : "chat" } });
      onCreated(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function browse() {
    const picked = await desktop?.pickFolder();
    if (picked) setFolder(picked);
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>New session</h2>
        <label className="field">
          <span>Project folder</span>
          <div className="row">
            <input
              autoFocus
              className="mono"
              value={folder}
              placeholder={desktop ? "Choose a folder, or leave empty for a chat" : "C:\\path\\to\\project — or leave empty for a chat"}
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && start()}
            />
            {desktop && <button onClick={browse}>Browse…</button>}
          </div>
        </label>
        {recent.length > 0 && (
          <div className="recent">
            {recent.slice(0, 8).map((r) => (
              <button key={r.path} className={`recent-item ${r.path === folder ? "sel" : ""}`} onClick={() => setFolder(r.path)} onDoubleClick={() => start(r.path)} title={r.path}>
                <span>{basename(r.path)}</span>
                <span className="muted mono">{r.path}</span>
              </button>
            ))}
          </div>
        )}
        <div className="grid2">
          <label className="field">
            <span>Agent</span>
            <select value={effectiveAgent} onChange={(e) => setAgent(e.target.value)}>
              {agents.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Permissions</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="muted small">{MODE_HELP[mode]}</div>
        {error && <div className="issue error">{error}</div>}
        <div className="row end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy} onClick={() => start()}>
            {folder ? `Open ${basename(folder)}` : "Start chat"}
          </button>
        </div>
      </div>
    </div>
  );
}
