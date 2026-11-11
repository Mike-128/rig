import { useEffect, useState } from "react";
import { api } from "../api";

export interface McpServerStatus {
  name: string;
  transport: "stdio" | "http" | "sse";
  status: "connecting" | "connected" | "failed" | "disabled";
  error?: string;
  tools: { name: string; fullName: string; description: string; readOnly: boolean }[];
}

interface McpInfo {
  configPath: string;
  config: string;
  example: string;
  servers: McpServerStatus[];
}

export function McpPage() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    api<McpInfo>("/mcp")
      .then((i) => {
        setInfo(i);
        setText(i.config);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await api<{ servers: McpServerStatus[] }>("/mcp", { method: "PUT", json: { config: text } });
      setInfo((i) => (i ? { ...i, config: text, servers: r.servers } : i));
      setMsg(`Saved. ${r.servers.filter((s) => s.status === "connected").length} of ${r.servers.length} server(s) connected.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reconnect() {
    setBusy(true);
    try {
      const r = await api<{ servers: McpServerStatus[] }>("/mcp/reload", { method: "POST" });
      setInfo((i) => (i ? { ...i, servers: r.servers } : i));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="content">
      <div className="scroll">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>MCP servers</h2>
          <button disabled={busy} onClick={reconnect}>
            Reconnect all
          </button>
        </div>
        <div className="muted small" style={{ marginBottom: 14, maxWidth: 760 }}>
          Tools from Model Context Protocol servers. Agents use them when their tool list includes <span className="mono">mcp__*</span> (every server),{" "}
          <span className="mono">mcp__name__*</span> (one server), or a single tool. Tools a server marks read-only run freely; everything else asks for approval
          unless the session's mode allows it.
        </div>
        {error && <div className="issue error">{error}</div>}
        {msg && <div className="issue ok">{msg}</div>}

        {info?.servers.map((s) => (
          <div key={s.name} className="card">
            <div className="row">
              <span className={`dot ${s.status === "connected" ? "ok" : s.status === "failed" ? "error" : s.status === "connecting" ? "running" : ""}`} />
              <b>{s.name}</b>
              <span className="badge">{s.transport}</span>
              <span className="muted small">{s.status}</span>
              {s.status === "connected" && <span className="muted small">{s.tools.length} tools</span>}
            </div>
            {s.error && <pre className="output err" style={{ whiteSpace: "pre-wrap" }}>{s.error}</pre>}
            {s.tools.length > 0 && (
              <div className="mcp-tools">
                {s.tools.map((t) => (
                  <div key={t.fullName} title={t.description}>
                    <span className="mono">{t.fullName}</span> {t.readOnly && <span className="badge">read-only</span>}{" "}
                    <span className="muted small clamp">{t.description}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {info && !info.servers.length && <div className="muted" style={{ marginBottom: 14 }}>No servers configured yet.</div>}

        <div className="card">
          <h3>Configuration</h3>
          <div className="muted small" style={{ marginBottom: 8 }}>
            <span className="mono">{info?.configPath}</span> — the same <span className="mono">mcpServers</span> format Claude Code uses, so server entries can be
            pasted in. <span className="mono">{"${VAR}"}</span> expands from the environment.
          </div>
          <textarea className="mono" rows={16} spellCheck={false} value={text} placeholder={info?.example} onChange={(e) => setText(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy} onClick={save}>
              {busy ? "Connecting…" : "Save and connect"}
            </button>
            {!text.trim() && info && <button onClick={() => setText(info.example)}>Start from an example</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
