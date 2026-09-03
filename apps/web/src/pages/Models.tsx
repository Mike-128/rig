import { useEffect, useState } from "react";
import type { Connection, GatewayProfile, Model, ModelAlias } from "@harness/core/types";
import { api } from "../api";

type ModelRow = Model & { connectionName: string };

export function ModelsPage() {
  const [profiles, setProfiles] = useState<GatewayProfile[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState("google-gemini");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [headerName, setHeaderName] = useState("");

  const [manualFor, setManualFor] = useState<string | null>(null);
  const [manual, setManual] = useState({ id: "", dialect: "openai.chat", route: "", bodyModel: "", maxTokensField: "max_tokens", reasoning: false });

  const refresh = async () => {
    const [p, c, m, a] = await Promise.all([
      api<GatewayProfile[]>("/profiles"),
      api<Connection[]>("/connections"),
      api<ModelRow[]>("/models"),
      api<ModelAlias[]>("/aliases"),
    ]);
    setProfiles(p);
    setConnections(c);
    setModels(m);
    setAliases(a);
  };

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);

  const profile = profiles.find((p) => p.id === profileId);

  async function addConnection() {
    setError(null);
    setNotice(null);
    setBusy("add");
    try {
      const res = await api<{ connection: Connection }>("/connections", {
        method: "POST",
        json: { name, profileId, key, baseUrl: baseUrl || undefined, headerName: headerName || undefined },
      });
      setKey("");
      setName("");
      await refresh();
      await probe(res.connection.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function probe(connId: string) {
    setBusy(connId);
    setError(null);
    try {
      const res = await api<{ models: Model[]; listed: number; listError?: string }>(`/connections/${connId}/probe`, { method: "POST" });
      const entitled = res.models.filter((m) => m.status === "entitled").length;
      setNotice(`Probed ${res.models.filter((m) => m.origin !== "listed").length} catalog models: ${entitled} entitled. ${res.listed ? `${res.listed} more listed by the provider (probe them individually).` : ""}${res.listError ? ` Listing failed: ${res.listError}` : ""}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function probeOne(m: ModelRow) {
    setBusy(m.id);
    try {
      await api(`/models/${m.connectionId}/${encodeURIComponent(m.providerModelId)}/probe`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function removeConnection(id: string) {
    await api(`/connections/${id}`, { method: "DELETE" });
    await refresh();
  }

  async function setAlias(alias: string, m: ModelRow) {
    await api(`/aliases/${encodeURIComponent(alias)}`, { method: "PUT", json: { connectionId: m.connectionId, modelId: m.providerModelId } });
    await refresh();
  }

  async function removeModel(m: ModelRow) {
    await api(`/models/${m.connectionId}/${encodeURIComponent(m.providerModelId)}`, { method: "DELETE" });
    await refresh();
  }

  async function addManual() {
    if (!manualFor) return;
    setError(null);
    try {
      await api(`/connections/${manualFor}/models`, {
        method: "POST",
        json: { ...manual, bodyModel: manual.bodyModel || undefined },
      });
      setManualFor(null);
      setManual({ id: "", dialect: "openai.chat", route: "", bodyModel: "", maxTokensField: "max_tokens", reasoning: false });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const defaultAlias = aliases.find((a) => a.alias === "default");

  return (
    <div className="content">
      <div className="scroll">
        <h2 style={{ marginTop: 0 }}>Model Catalog</h2>
        {error && <div className="issue error">{error}</div>}
        {notice && <div className="issue" style={{ color: "var(--ok)" }}>{notice}</div>}

        <div className="card">
          <h3>Add a connection</h3>
          <div className="grid2">
            <label className="field">
              <span>Gateway profile</span>
              <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
              {profile && <span className="muted">{profile.description}</span>}
            </label>
            <label className="field">
              <span>Connection name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. gemini-personal" />
            </label>
          </div>
          <label className="field">
            <span>Key (stored in the OS keychain, never shown again)</span>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
          </label>
          <div className="grid2">
            <label className="field">
              <span>Base URL override {profile ? `(default ${profile.baseUrl})` : ""}</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={profile?.template ? "required for templates" : "optional"} />
            </label>
            <label className="field">
              <span>Auth header override {profile ? `(default ${profile.auth.headerName})` : ""}</span>
              <input value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder="optional" />
            </label>
          </div>
          <button className="primary" onClick={addConnection} disabled={!name.trim() || !key.trim() || busy === "add"}>
            {busy === "add" ? "Adding and probing…" : "Add and probe"}
          </button>
        </div>

        {connections.length === 0 && <div className="empty">No connections yet. Add one above.</div>}

        {connections.map((c) => {
          const rows = models.filter((m) => m.connectionId === c.id);
          return (
            <div className="card" key={c.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>{c.name}</strong> <span className="badge">{c.kind}</span> <span className="muted mono">{c.baseUrl}</span>{" "}
                  <span className="muted">
                    · {c.auth.headerName} · key …{c.secretLast4}
                  </span>
                </div>
                <div className="row">
                  <button onClick={() => probe(c.id)} disabled={busy === c.id}>
                    {busy === c.id ? "Probing…" : "List and probe"}
                  </button>
                  <button onClick={() => setManualFor(manualFor === c.id ? null : c.id)}>Add model manually</button>
                  <button className="danger" onClick={() => removeConnection(c.id)}>
                    Remove
                  </button>
                </div>
              </div>
              {manualFor === c.id && (
                <div className="card" style={{ marginTop: 10 }}>
                  <div className="grid2">
                    <label className="field">
                      <span>Model id (sent in the body unless overridden)</span>
                      <input value={manual.id} onChange={(e) => setManual({ ...manual, id: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>Dialect</span>
                      <select value={manual.dialect} onChange={(e) => setManual({ ...manual, dialect: e.target.value })}>
                        <option value="openai.chat">openai.chat</option>
                        <option value="anthropic.messages">anthropic.messages</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Route (path appended to base URL)</span>
                      <input value={manual.route} onChange={(e) => setManual({ ...manual, route: e.target.value })} placeholder="/v1/chat/completions" />
                    </label>
                    <label className="field">
                      <span>Body model override (optional)</span>
                      <input value={manual.bodyModel} onChange={(e) => setManual({ ...manual, bodyModel: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>Max tokens field (OpenAI dialect)</span>
                      <select value={manual.maxTokensField} onChange={(e) => setManual({ ...manual, maxTokensField: e.target.value })}>
                        <option value="max_tokens">max_tokens</option>
                        <option value="max_completion_tokens">max_completion_tokens</option>
                      </select>
                    </label>
                    <label className="field checks">
                      <input type="checkbox" checked={manual.reasoning} onChange={(e) => setManual({ ...manual, reasoning: e.target.checked })} /> supports reasoning effort
                    </label>
                  </div>
                  <button className="primary" onClick={addManual} disabled={!manual.id || !manual.route}>
                    Add model
                  </button>
                </div>
              )}
              <table style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Dialect</th>
                    <th>Status</th>
                    <th>Detail</th>
                    <th>Alias</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => {
                    const boundAliases = aliases.filter((a) => a.connectionId === m.connectionId && a.modelId === m.providerModelId).map((a) => a.alias);
                    return (
                      <tr key={m.id}>
                        <td>
                          {m.displayName}
                          <div className="muted mono">
                            {m.providerModelId} · {m.route}
                          </div>
                        </td>
                        <td className="mono">{m.dialect}</td>
                        <td>
                          <span className={`badge ${m.status}`}>{m.status}</span>
                        </td>
                        <td className="muted" style={{ maxWidth: 320 }}>
                          {m.statusMessage}
                        </td>
                        <td>
                          {boundAliases.map((a) => (
                            <span key={a} className="badge" style={{ marginRight: 4 }}>
                              {a}
                            </span>
                          ))}
                          {m.status === "entitled" && !boundAliases.includes("default") && (
                            <button onClick={() => setAlias("default", m)} title={defaultAlias ? `replaces ${defaultAlias.modelId}` : ""}>
                              set as default
                            </button>
                          )}
                          {m.status === "entitled" && (
                            <button
                              style={{ marginLeft: 4 }}
                              onClick={() => {
                                const a = prompt("Alias name (e.g. fast, smart)");
                                if (a) setAlias(a.trim(), m);
                              }}
                            >
                              alias…
                            </button>
                          )}
                        </td>
                        <td>
                          <button onClick={() => probeOne(m)} disabled={busy === m.id}>
                            {busy === m.id ? "…" : "probe"}
                          </button>{" "}
                          <button className="danger" onClick={() => removeModel(m)}>
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!rows.length && (
                    <tr>
                      <td colSpan={6} className="muted">
                        No models. Use "List and probe" or add one manually.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          );
        })}

        {aliases.length > 0 && (
          <div className="card">
            <h3>Aliases</h3>
            <table>
              <tbody>
                {aliases.map((a) => (
                  <tr key={a.alias}>
                    <td>
                      <strong>{a.alias}</strong>
                    </td>
                    <td className="mono">
                      {connections.find((c) => c.id === a.connectionId)?.name ?? a.connectionId} / {a.modelId}
                    </td>
                    <td>
                      <button
                        className="danger"
                        onClick={async () => {
                          await api(`/aliases/${encodeURIComponent(a.alias)}`, { method: "DELETE" });
                          refresh();
                        }}
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
