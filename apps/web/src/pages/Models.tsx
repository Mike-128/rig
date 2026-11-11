import { useEffect, useMemo, useState } from "react";
import type { Connection, GatewayProfile, Model, ModelAlias } from "@rig/core/types";
import { api } from "../api";
import { announceSetupChange, STATUS_HELP, STATUS_LABEL, useSetup } from "../setup";

type ModelRow = Model & { connectionName: string };

/** Statuses that say the model cannot be used; anything else may still work. */
const BROKEN = new Set(["unauthorized", "forbidden", "not_found"]);

/** One sentence per probe, turning the per-model results into what to do next. */
function findings(rows: Model[], listError?: string): string[] {
  const tested = rows.filter((m) => m.status !== "listed" && m.status !== "unprobed");
  const count = (s: string) => tested.filter((m) => m.status === s).length;
  const out: string[] = [];
  if (!tested.length) out.push("Nothing was tested. Add a model manually, or use List and test.");
  else if (count("entitled") === tested.length) out.push(tested.length === 1 ? "The tested model works with this key." : `All ${tested.length} tested models work with this key.`);
  else if (count("entitled")) out.push(`${count("entitled")} of ${tested.length} tested models work with this key.`);
  if (tested.length && count("unauthorized") === tested.length) out.push("The provider rejected the key for every model: check the key, and the header it is sent in (Advanced).");
  else if (count("unauthorized")) out.push(`${count("unauthorized")} rejected the key.`);
  if (count("forbidden")) out.push(`${count("forbidden")} answered "not allowed": the key works but has no access to ${count("forbidden") === 1 ? "that model" : "those models"}.`);
  if (count("not_found")) out.push(`${count("not_found")} were not found: check the base URL, the route, and the model ids.`);
  if (count("rate_limited")) out.push(`${count("rate_limited")} were rate limited. Test them again in a minute.`);
  if (listError) out.push(`Listing the provider's models failed: ${listError}`);
  return out;
}

export function ModelsPage() {
  const [profiles, setProfiles] = useState<GatewayProfile[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ connection: string; lines: string[] } | null>(null);
  const [adding, setAdding] = useState(false);

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
    setLoaded(true);
    announceSetupChange();
    return { models: m, aliases: a };
  };

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);

  const defaultAlias = aliases.find((a) => a.alias === "default");
  const usable = models.filter((m) => !BROKEN.has(m.status));

  async function setAlias(alias: string, connectionId: string, modelId: string) {
    setError(null);
    try {
      await api(`/aliases/${encodeURIComponent(alias)}`, { method: "PUT", json: { connectionId, modelId } });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function probe(conn: Connection) {
    setBusy(conn.id);
    setError(null);
    try {
      const res = await api<{ models: Model[]; listed: number; listError?: string }>(`/connections/${conn.id}/probe`, { method: "POST" });
      const lines = findings(res.models, res.listError);
      if (res.listed) lines.push(`The provider lists ${res.listed} more model${res.listed === 1 ? "" : "s"}; test any of them from the table.`);
      const hadDefault = aliases.some((a) => a.alias === "default");
      const after = await refresh();
      // The runtime binds the default to a working model when there is none; say which it chose.
      const bound = after.aliases.find((a) => a.alias === "default");
      if (!hadDefault && bound) {
        const m = after.models.find((x) => x.connectionId === bound.connectionId && x.providerModelId === bound.modelId);
        lines.push(`${m?.displayName ?? bound.modelId} is now the default model. Change it below.`);
      }
      setReport({ connection: conn.name, lines });
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

  async function removeConnection(c: Connection) {
    if (!confirm(`Remove ${c.name}? Its key is deleted from the keychain, and agents bound to its models stop working.`)) return;
    await api(`/connections/${c.id}`, { method: "DELETE" });
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
      await api(`/connections/${manualFor}/models`, { method: "POST", json: { ...manual, bodyModel: manual.bodyModel || undefined } });
      setManualFor(null);
      setManual({ id: "", dialect: "openai.chat", route: "", bodyModel: "", maxTokensField: "max_tokens", reasoning: false });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const showAdd = adding || (loaded && connections.length === 0);

  return (
    <div className="content">
      <div className="scroll">
        <div className="page">
          <div className="page-head">
            <div>
              <h2>Models</h2>
              <p className="muted">
                A provider is where models run: Anthropic, OpenAI, Google, a gateway, or a server on your machine. Agents ask for an alias such as <span className="mono">default</span>, and you decide here which model answers it.
              </p>
            </div>
            {!showAdd && (
              <button className="primary" onClick={() => setAdding(true)}>
                Add a provider
              </button>
            )}
          </div>
          {error && <div className="issue error">{error}</div>}
          {report && (
            <div className="findings" role="status">
              <div className="findings-head">
                <strong>Tested {report.connection}</strong>
                <button className="ghost tiny" onClick={() => setReport(null)}>
                  Dismiss
                </button>
              </div>
              <ul>
                {report.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          )}

          {showAdd && (
            <AddProvider
              profiles={profiles}
              existing={connections}
              onCancel={connections.length ? () => setAdding(false) : undefined}
              onAdded={async (conn) => {
                setAdding(false);
                await refresh();
                await probe(conn);
              }}
            />
          )}

          {connections.length > 0 && (
            <section className="card">
              <h3>Default model</h3>
              <p className="muted small">Agents bound to the alias default use this model. Each teammate picks their own, so shared agents run on whatever each person has.</p>
              <div className="row">
                <select
                  className="grow"
                  value={defaultAlias ? `${defaultAlias.connectionId}\n${defaultAlias.modelId}` : ""}
                  onChange={(e) => {
                    const [c, m] = e.target.value.split("\n");
                    if (c && m) setAlias("default", c, m);
                  }}
                >
                  {!defaultAlias && <option value="">Choose a model…</option>}
                  {connections.map((c) => (
                    <optgroup key={c.id} label={c.name}>
                      {usable
                        .filter((m) => m.connectionId === c.id)
                        .map((m) => (
                          <option key={m.id} value={`${m.connectionId}\n${m.providerModelId}`}>
                            {m.displayName} ({STATUS_LABEL[m.status] ?? m.status})
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              {defaultAlias && BROKEN.has(models.find((m) => m.connectionId === defaultAlias.connectionId && m.providerModelId === defaultAlias.modelId)?.status ?? "") && (
                <div className="issue error">The default model failed its last test. Pick another, or fix its provider below.</div>
              )}
              {!usable.length && <div className="issue warning">No model has passed a test yet. Use List and test on a provider below.</div>}
            </section>
          )}

          {connections.map((c) => {
            const rows = models.filter((m) => m.connectionId === c.id);
            return (
              <section className="card" key={c.id}>
                <div className="card-head">
                  <div className="titles">
                    <h3>
                      {c.name} <span className="badge">{c.kind}</span>
                    </h3>
                    <div className="muted small">
                      <span className="mono">{c.baseUrl}</span>, key in {c.auth.headerName} ending <span className="mono">{c.secretLast4}</span>
                    </div>
                  </div>
                  <div className="row">
                    <button onClick={() => probe(c)} disabled={busy === c.id}>
                      {busy === c.id ? "Testing…" : "List and test"}
                    </button>
                    <button onClick={() => setManualFor(manualFor === c.id ? null : c.id)}>Add a model by id</button>
                    <button className="danger" onClick={() => removeConnection(c)}>
                      Remove
                    </button>
                  </div>
                </div>
                {manualFor === c.id && (
                  <div className="subsection">
                    <div className="grid2">
                      <label className="field">
                        <span>Model id</span>
                        <input value={manual.id} onChange={(e) => setManual({ ...manual, id: e.target.value })} placeholder="e.g. llama3.1:8b" />
                        <span className="hint">Sent in the request body unless you override it below.</span>
                      </label>
                      <label className="field">
                        <span>Dialect</span>
                        <select value={manual.dialect} onChange={(e) => setManual({ ...manual, dialect: e.target.value })}>
                          <option value="openai.chat">OpenAI Chat Completions</option>
                          <option value="anthropic.messages">Anthropic Messages</option>
                        </select>
                      </label>
                      <label className="field">
                        <span>Route</span>
                        <input value={manual.route} onChange={(e) => setManual({ ...manual, route: e.target.value })} placeholder={manual.dialect === "openai.chat" ? "/v1/chat/completions" : "/v1/messages"} />
                        <span className="hint">The path added to the base URL.</span>
                      </label>
                      <label className="field">
                        <span>Model id in the body (optional)</span>
                        <input value={manual.bodyModel} onChange={(e) => setManual({ ...manual, bodyModel: e.target.value })} />
                        <span className="hint">For gateways whose deployment name differs from the model id.</span>
                      </label>
                      {manual.dialect === "openai.chat" && (
                        <label className="field">
                          <span>Max tokens field</span>
                          <select value={manual.maxTokensField} onChange={(e) => setManual({ ...manual, maxTokensField: e.target.value })}>
                            <option value="max_tokens">max_tokens</option>
                            <option value="max_completion_tokens">max_completion_tokens (newer OpenAI models)</option>
                          </select>
                        </label>
                      )}
                      <label className="field checks">
                        <input type="checkbox" checked={manual.reasoning} onChange={(e) => setManual({ ...manual, reasoning: e.target.checked })} /> Supports a reasoning effort setting
                      </label>
                    </div>
                    <div className="row">
                      <button className="primary" onClick={addManual} disabled={!manual.id || !manual.route}>
                        Add model
                      </button>
                      <button className="ghost" onClick={() => setManualFor(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                <table>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Dialect</th>
                      <th>Test result</th>
                      <th>Detail</th>
                      <th>Aliases</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => {
                      const bound = aliases.filter((a) => a.connectionId === m.connectionId && a.modelId === m.providerModelId).map((a) => a.alias);
                      return (
                        <tr key={m.id}>
                          <td>
                            {m.displayName}
                            <div className="muted mono">
                              {m.providerModelId} on {m.route}
                            </div>
                          </td>
                          <td className="mono">{m.dialect}</td>
                          <td>
                            <span className={`badge ${m.status}`} title={STATUS_HELP[m.status]}>
                              {STATUS_LABEL[m.status] ?? m.status}
                            </span>
                          </td>
                          <td className="muted detail">{m.statusMessage}</td>
                          <td>
                            <div className="row tight">
                              {bound.map((a) => (
                                <span key={a} className="badge">
                                  {a}
                                </span>
                              ))}
                              {!BROKEN.has(m.status) && (
                                <button
                                  className="tiny"
                                  onClick={() => {
                                    const a = prompt("Alias name, e.g. fast or smart. Agents can ask for it instead of a model.");
                                    if (a?.trim()) setAlias(a.trim(), m.connectionId, m.providerModelId);
                                  }}
                                >
                                  Add alias
                                </button>
                              )}
                            </div>
                          </td>
                          <td>
                            <div className="row tight end">
                              <button className="tiny" onClick={() => probeOne(m)} disabled={busy === m.id}>
                                {busy === m.id ? "Testing…" : "Test"}
                              </button>
                              <button className="tiny danger" onClick={() => removeModel(m)} aria-label={`Remove ${m.displayName}`}>
                                Remove
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!rows.length && (
                      <tr>
                        <td colSpan={6} className="muted">
                          No models yet. Use List and test, or add a model by id.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>
            );
          })}

          {aliases.length > 0 && (
            <section className="card">
              <h3>Aliases</h3>
              <p className="muted small">Names agents use instead of a specific model. They live on this machine only.</p>
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
                      <td className="end-cell">
                        <button
                          className="tiny danger"
                          onClick={async () => {
                            await api(`/aliases/${encodeURIComponent(a.alias)}`, { method: "DELETE" });
                            refresh();
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** The add-a-provider form, in rig-probe's shape: a preset first, then only the fields it needs. */
function AddProvider({ profiles, existing, onAdded, onCancel }: { profiles: GatewayProfile[]; existing: Connection[]; onAdded(c: Connection): void; onCancel?: () => void }) {
  const [profileId, setProfileId] = useState("");
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setup } = useSetup();
  const storedIn = setup?.secrets === "os-keychain" ? "your OS keychain" : "an encrypted file in Rig's data folder (the OS keychain was not available)";

  const profile = profiles.find((p) => p.id === (profileId || profiles[0]?.id));
  const local = profile ? /localhost|127\.0\.0\.1/.test(profile.baseUrl) : false;
  // A unique name the user can leave alone: the preset's id, numbered when taken.
  const suggested = useMemo(() => {
    const base = profile?.id.replace(/-(direct|gateway)$/, "") ?? "provider";
    let n = 1;
    let s = base;
    while (existing.some((c) => c.name === s)) s = `${base}-${++n}`;
    return s;
  }, [profile, existing]);
  const needsUrl = Boolean(profile?.template) && !baseUrl.trim();

  async function submit() {
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ connection: Connection }>("/connections", {
        method: "POST",
        json: { name: name.trim() || suggested, profileId: profile.id, key: key || (local ? "local" : ""), baseUrl: baseUrl.trim() || undefined, headerName: headerName.trim() || undefined },
      });
      setKey("");
      onAdded(res.connection);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return null;
  const sentAs = `${headerName.trim() || profile.auth.headerName}: ${profile.auth.prefix ?? ""}…`;

  return (
    <section className="card add-provider">
      <h3>Add a provider</h3>
      <ol className="steps">
        <li>
          <div className="step-title">Choose where the models run</div>
          <select value={profile.id} onChange={(e) => setProfileId(e.target.value)} aria-label="Provider">
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          {profile.description && <p className="hint">{profile.description}</p>}
        </li>
        <li>
          <div className="step-title">{local ? "Point Rig at the server" : "Paste the key"}</div>
          {profile.template && (
            <label className="field">
              <span>Base URL</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={profile.baseUrl} spellCheck={false} />
              <span className="hint">{local ? "Where the server listens. The address shown is the usual one." : "Your gateway's URL, without the route."}</span>
            </label>
          )}
          <label className="field">
            <span>Key{local ? " (optional)" : ""}</span>
            <div className="row nowrap">
              <input
                className="grow"
                type={reveal ? "text" : "password"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(e) => e.key === "Enter" && !busy && (key || local) && !needsUrl && submit()}
              />
              <button type="button" className="ghost" onClick={() => setReveal(!reveal)}>
                {reveal ? "Hide" : "Show"}
              </button>
            </div>
            <span className="hint">
              Sent as <span className="mono">{sentAs}</span>. Stored in {storedIn}, and never shown again.
            </span>
          </label>
          <details className="advanced">
            <summary>Advanced</summary>
            <div className="grid2">
              <label className="field">
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested} />
                <span className="hint">How this provider appears in Rig.</span>
              </label>
              <label className="field">
                <span>Header for the key</span>
                <input value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder={profile.auth.headerName} />
                <span className="hint">Change it if your gateway expects the key elsewhere.</span>
              </label>
              {!profile.template && (
                <label className="field">
                  <span>Base URL</span>
                  <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={profile.baseUrl} spellCheck={false} />
                  <span className="hint">Only to route through a proxy.</span>
                </label>
              )}
            </div>
          </details>
        </li>
        <li>
          <div className="step-title">Connect and test</div>
          <p className="hint">Rig sends each known model a tiny request (a few tokens), so you see which ones the key can reach before anything depends on them.</p>
          {error && <div className="issue error">{error}</div>}
          <div className="row">
            <button className="primary" onClick={submit} disabled={busy || (!key && !local) || needsUrl}>
              {busy ? "Connecting…" : "Connect and test"}
            </button>
            {onCancel && (
              <button className="ghost" onClick={onCancel}>
                Cancel
              </button>
            )}
          </div>
        </li>
      </ol>
    </section>
  );
}
