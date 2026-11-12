import { useEffect, useMemo, useState } from "react";
import type { Connection, GatewayProfile, Model, ModelAlias } from "@rig/core/types";
import { api } from "../api";
import { announceSetupChange, STATUS_HELP, STATUS_LABEL, useSetup } from "../setup";
import { DiscoverySettings, HeaderFields, headerRecord, headerRows, type HeaderRow } from "../ConnectionSettings";

type ModelRow = Model & { connectionName: string };
type Tab = "models" | "connection" | "discovery";
type Report = { connectionId: string; lines: string[] };
type ProbeOptions = { includeListed?: boolean; discover?: boolean; lead?: string[] };

const TABS: { id: Tab; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "connection", label: "Connection" },
  { id: "discovery", label: "Discovery" },
];

const emptyManual = { id: "", displayName: "", dialect: "openai.chat", route: "", bodyModel: "", maxTokensField: "max_tokens", reasoning: false, query: "{}" };
type ManualForm = typeof emptyManual;

/** Statuses that say the model cannot be used; anything else may still work. */
const BROKEN = new Set(["unauthorized", "forbidden", "not_found"]);
const untested = (m: Model) => m.status === "listed" || m.status === "unprobed";

/** The query-parameter box holds JSON text; the API wants an object of strings. */
function parseQuery(text: string): Record<string, string> {
  let query: unknown;
  try {
    query = JSON.parse(text || "{}");
  } catch {
    throw new Error('Query parameters must be a JSON object, for example {"api-version":"2024-12-01-preview"}.');
  }
  if (!query || typeof query !== "object" || Array.isArray(query) || Object.values(query).some((v) => typeof v !== "string")) {
    throw new Error("Query parameters must be an object with string values.");
  }
  return query as Record<string, string>;
}

/** The body for a new manual model, leaving optional fields out when blank. */
function manualBody(m: ManualForm) {
  return { ...m, id: m.id.trim(), route: m.route.trim(), query: parseQuery(m.query), displayName: m.displayName || undefined, bodyModel: m.bodyModel || undefined };
}

function formFor(m: Model): ManualForm {
  return {
    id: m.providerModelId,
    displayName: m.displayName,
    dialect: m.dialect,
    route: m.route,
    bodyModel: m.bodyModel === m.providerModelId ? "" : (m.bodyModel ?? ""),
    maxTokensField: m.params?.maxTokensField ?? "max_tokens",
    reasoning: Boolean(m.capabilities?.reasoning),
    query: JSON.stringify(m.query ?? {}, null, 2),
  };
}

/** One sentence per probe, turning the per-model results into what to do next. */
function findings(rows: Model[], listError?: string, found?: number): string[] {
  const tested = rows.filter((m) => !untested(m));
  const count = (s: string) => tested.filter((m) => m.status === s).length;
  const out: string[] = [];
  if (!tested.length) out.push("Nothing was tested. Add a model, or check Discovery.");
  else if (count("entitled") === tested.length) out.push(tested.length === 1 ? "The tested model is reachable with this key." : `All ${tested.length} tested models are reachable with this key.`);
  else if (count("entitled")) out.push(`${count("entitled")} of ${tested.length} tested models are reachable with this key.`);
  if (count("entitled")) out.push("Reachable includes a request the provider rejected only for validation, so send a chat before relying on a model.");
  if (tested.length && count("unauthorized") === tested.length) out.push("The provider rejected the key for every model. Check the key and the header it is sent in, under Connection.");
  else if (count("unauthorized")) out.push(`${count("unauthorized")} rejected the key.`);
  if (count("forbidden")) out.push(`${count("forbidden")} answered "not allowed": the key works but has no access to ${count("forbidden") === 1 ? "that model" : "those models"}.`);
  if (count("not_found")) out.push(`${count("not_found")} were not found. Check the base URL under Connection, and each model's route.`);
  if (count("unknown")) out.push(`${count("unknown")} gave an unexpected answer, which usually means the base URL is wrong or unreachable. Check it under Connection.`);
  if (count("rate_limited")) out.push(`${count("rate_limited")} were rate limited. Test them again in a minute.`);
  if (found !== undefined) out.push(`The listing returned ${found} unique id${found === 1 ? "" : "s"}.`);
  if (listError) out.push(`Discovery: ${listError}`);
  return out;
}

/** A provider's standing in the list, from its models' last results. */
function standing(rows: Model[]): { label: string; status: string } {
  const tested = rows.filter((m) => !untested(m));
  const ok = tested.filter((m) => m.status === "entitled").length;
  if (!rows.length) return { label: "No models", status: "unprobed" };
  if (!tested.length) return { label: "Not tested", status: "unprobed" };
  if (tested.every((m) => m.status === "unauthorized")) return { label: "Key rejected", status: "unauthorized" };
  if (!ok) return { label: "Nothing reachable", status: "not_found" };
  return { label: `${ok} reachable`, status: ok === tested.length ? "entitled" : "rate_limited" };
}

/** Where a request for this route goes: what to check when a base URL was mistyped. */
function joinUrl(base: string, route: string): string {
  if (!base) return route;
  return `${base.replace(/\/+$/, "")}${route.startsWith("/") ? "" : "/"}${route}`;
}

export function ModelsPage() {
  const [profiles, setProfiles] = useState<GatewayProfile[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("models");
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);

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

  const current = selected === "new" ? undefined : (connections.find((c) => c.id === selected) ?? connections[0]);
  const adding = selected === "new" || (loaded && !connections.length);

  function select(id: string) {
    setSelected(id);
    setTab("models");
    setError(null);
  }

  async function run<T>(what: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    try {
      return await what();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    }
  }

  const setAlias = (alias: string, connectionId: string, modelId: string) =>
    run(async () => {
      await api(`/aliases/${encodeURIComponent(alias)}`, { method: "PUT", json: { connectionId, modelId } });
      await refresh();
    });

  const deleteAlias = (alias: string) =>
    run(async () => {
      await api(`/aliases/${encodeURIComponent(alias)}`, { method: "DELETE" });
      await refresh();
    });

  /** Test a provider's models. discover=false skips asking the provider for its list. */
  async function probe(conn: Connection, { includeListed = false, discover = true, lead = [] }: ProbeOptions = {}) {
    setBusy(conn.id);
    setReport(null);
    await run(async () => {
      const res = await api<{ models: Model[]; listed: number; found?: number; listError?: string }>(`/connections/${conn.id}/probe?includeListed=${includeListed}&discover=${discover}`, { method: "POST" });
      const lines = [...lead, ...findings(includeListed ? res.models : res.models.filter((m) => m.origin !== "listed"), res.listError, res.found)];
      if (res.listed) lines.push(`${res.listed} new model${res.listed === 1 ? " was" : "s were"} added from the listing; models you already had keep their settings.${includeListed ? "" : " Scan inventory tests them too."}`);
      const hadDefault = aliases.some((a) => a.alias === "default");
      const after = await refresh();
      // The runtime binds the default to a working model when there is none; say which it chose.
      const bound = after.aliases.find((a) => a.alias === "default");
      if (!hadDefault && bound) {
        const m = after.models.find((x) => x.connectionId === bound.connectionId && x.providerModelId === bound.modelId);
        lines.push(`${m?.displayName ?? bound.modelId} is now the default model.`);
      }
      setReport({ connectionId: conn.id, lines });
    });
    setBusy(null);
  }

  async function probeOne(m: ModelRow) {
    setBusy(m.id);
    await run(async () => {
      await api(`/models/${m.connectionId}/${encodeURIComponent(m.providerModelId)}/probe`, { method: "POST" });
      await refresh();
    });
    setBusy(null);
  }

  async function removeConnection(c: Connection) {
    if (!confirm(`Remove ${c.name}? Its key and models are deleted, and agents bound to its models stop working.`)) return;
    await run(async () => {
      await api(`/connections/${c.id}`, { method: "DELETE" });
      setSelected(null);
      setReport(null);
      await refresh();
    });
  }

  async function removeModel(m: ModelRow) {
    if (!confirm(`Remove ${m.displayName}? Aliases pointing at it stop working.`)) return;
    await run(async () => {
      await api(`/models/${m.connectionId}/${encodeURIComponent(m.providerModelId)}`, { method: "DELETE" });
      await refresh();
    });
  }

  const addProvider = (
    <AddProvider
      profiles={profiles}
      existing={connections}
      onCancel={connections.length ? () => setSelected(null) : undefined}
      onAdded={async (conn, named) => {
        setSelected(conn.id);
        setTab("models");
        await refresh();
        // A named model is tested on its own route; asking the provider for a list is a separate step.
        await probe(conn, { discover: !named });
      }}
    />
  );

  return (
    <div className="content">
      <div className="scroll">
        <div className="page models-page">
          <div className="page-head">
            <div>
              <h2>Models</h2>
              <p className="muted">
                A provider is where models run: Anthropic, OpenAI, Google, a gateway, or a server on your machine. Agents ask for an alias such as <span className="mono">default</span>, and you choose here which model answers it.
              </p>
            </div>
          </div>
          {error && (
            <div className="issue error" role="alert">
              {error}
            </div>
          )}

          {!loaded ? (
            <p className="muted">Loading…</p>
          ) : !connections.length ? (
            <div className="card">{addProvider}</div>
          ) : (
            <>
              <DefaultModel connections={connections} models={models} aliases={aliases} onSet={setAlias} onDelete={deleteAlias} />
              <div className="providers">
                <nav className="provider-list" aria-label="Providers">
                  {connections.map((c) => {
                    const rows = models.filter((m) => m.connectionId === c.id);
                    const s = standing(rows);
                    const active = !adding && current?.id === c.id;
                    return (
                      <button key={c.id} className={`provider-item ${active ? "active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => select(c.id)}>
                        <span className="provider-name">{c.name}</span>
                        <span className="provider-sub">
                          <span className={`badge ${s.status}`}>{s.label}</span>
                          <span>
                            {rows.length} model{rows.length === 1 ? "" : "s"}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  <button className={`provider-add ${adding ? "active" : ""}`} aria-current={adding ? "true" : undefined} onClick={() => select("new")}>
                    Add a provider
                  </button>
                </nav>
                <div className="card provider-detail">
                  {adding
                    ? addProvider
                    : current && (
                        <ProviderDetail
                          key={current.id}
                          connection={current}
                          profile={profiles.find((p) => p.id === current.profileId)}
                          rows={models.filter((m) => m.connectionId === current.id)}
                          aliases={aliases}
                          tab={tab}
                          onTab={setTab}
                          busy={busy}
                          report={report?.connectionId === current.id ? report.lines : null}
                          onDismissReport={() => setReport(null)}
                          onProbe={(o) => probe(current, o)}
                          onProbeOne={probeOne}
                          onRemoveModel={removeModel}
                          onSetAlias={(alias, m) => setAlias(alias, m.connectionId, m.providerModelId)}
                          onDeleteAlias={deleteAlias}
                          onChanged={refresh}
                          onRemove={() => removeConnection(current)}
                        />
                      )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The default model, and any other aliases, above the providers. */
function DefaultModel({
  connections,
  models,
  aliases,
  onSet,
  onDelete,
}: {
  connections: Connection[];
  models: ModelRow[];
  aliases: ModelAlias[];
  onSet(alias: string, connectionId: string, modelId: string): void;
  onDelete(alias: string): void;
}) {
  const def = aliases.find((a) => a.alias === "default");
  const bound = def && models.find((m) => m.connectionId === def.connectionId && m.providerModelId === def.modelId);
  const others = aliases.filter((a) => a.alias !== "default");
  const isDefault = (m: Model) => def?.connectionId === m.connectionId && def.modelId === m.providerModelId;
  const anyUsable = models.some((m) => !BROKEN.has(m.status));
  return (
    <section className="default-bar" aria-label="Default model">
      <label className="field">
        <span>Default model</span>
        <select
          value={def ? `${def.connectionId}\n${def.modelId}` : ""}
          onChange={(e) => {
            const [c, m] = e.target.value.split("\n");
            if (c && m) onSet("default", c, m);
          }}
        >
          {!def && <option value="">Choose a model…</option>}
          {connections.map((c) => (
            <optgroup key={c.id} label={c.name}>
              {models
                // A failing default stays listed so the box shows what is bound; other failing models are hidden.
                .filter((m) => m.connectionId === c.id && (!BROKEN.has(m.status) || isDefault(m)))
                .map((m) => (
                  <option key={m.id} value={`${m.connectionId}\n${m.providerModelId}`}>
                    {m.displayName} ({STATUS_LABEL[m.status] ?? m.status})
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="default-notes">
        {bound && BROKEN.has(bound.status) ? (
          <p className="issue error">The default model failed its last test. Pick another, or fix its provider below.</p>
        ) : !anyUsable ? (
          <p className="issue warning">No model has passed a test yet. Test a provider's models below.</p>
        ) : (
          <p className="hint">Agents bound to the alias default use this model. Each teammate picks their own, so shared agents run on whatever each person has.</p>
        )}
        {others.length > 0 && (
          <div className="alias-line">
            <span className="muted small">Other aliases</span>
            {others.map((a) => (
              <AliasChip key={a.alias} alias={a.alias} title={`${connections.find((c) => c.id === a.connectionId)?.name ?? a.connectionId} / ${a.modelId}`} onDelete={() => onDelete(a.alias)} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function AliasChip({ alias, title, onDelete }: { alias: string; title?: string; onDelete?: () => void }) {
  return (
    <span className="alias-chip" title={title}>
      {alias}
      {onDelete && (
        <button className="chip-x" onClick={onDelete} aria-label={`Remove alias ${alias}`}>
          ×
        </button>
      )}
    </span>
  );
}

function ProviderDetail(props: {
  connection: Connection;
  profile?: GatewayProfile;
  rows: ModelRow[];
  aliases: ModelAlias[];
  tab: Tab;
  onTab(t: Tab): void;
  busy: string | null;
  report: string[] | null;
  onDismissReport(): void;
  onProbe(o?: ProbeOptions): Promise<void>;
  onProbeOne(m: ModelRow): Promise<void>;
  onRemoveModel(m: ModelRow): Promise<void>;
  onSetAlias(alias: string, m: ModelRow): void;
  onDeleteAlias(alias: string): void;
  onChanged(): Promise<unknown>;
  onRemove(): void;
}) {
  const { connection: c, tab } = props;
  return (
    <>
      <div className="detail-head">
        <h3>
          {c.name} <span className="badge">{c.kind}</span>
        </h3>
        <div className="detail-meta">
          <span className="mono">{c.baseUrl}</span>
          <span className="muted small">
            Key in <span className="mono">{c.auth.headerName}</span>, ending <span className="mono">{c.secretLast4}</span>
          </span>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label={`${c.name} settings`}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} className="tab" onClick={() => props.onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {props.report && (
        <div className="findings" role="status">
          <div className="findings-head">
            <strong>Tested {c.name}</strong>
            <button className="ghost tiny" onClick={props.onDismissReport}>
              Dismiss
            </button>
          </div>
          <ul>
            {props.report.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "models" && <ModelsTab {...props} />}
        {tab === "connection" && (
          <ConnectionForm
            connection={c}
            sampleRoute={props.rows.find((m) => m.origin !== "listed")?.route ?? props.rows[0]?.route}
            busy={props.busy !== null}
            onSaved={async (changed) => {
              await props.onChanged();
              props.onTab("models");
              await props.onProbe({ discover: false, lead: [`Saved ${changed.join(", ")}. Models and aliases are unchanged; earlier results were cleared and the models were tested again.`] });
            }}
            onRemove={props.onRemove}
          />
        )}
        {tab === "discovery" && <DiscoverySettings connection={c} onSaved={props.onChanged} />}
      </div>
    </>
  );
}

function ModelsTab({
  connection: c,
  rows,
  aliases,
  busy,
  onProbe,
  onProbeOne,
  onRemoveModel,
  onSetAlias,
  onDeleteAlias,
  onChanged,
}: {
  connection: Connection;
  rows: ModelRow[];
  aliases: ModelAlias[];
  busy: string | null;
  onProbe(o?: ProbeOptions): Promise<void>;
  onProbeOne(m: ModelRow): Promise<void>;
  onRemoveModel(m: ModelRow): Promise<void>;
  onSetAlias(alias: string, m: ModelRow): void;
  onDeleteAlias(alias: string): void;
  onChanged(): Promise<unknown>;
}) {
  const [form, setForm] = useState<{ editing: ModelRow | null; value: ManualForm } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const boundTo = (m: Model) => aliases.filter((a) => a.connectionId === m.connectionId && a.modelId === m.providerModelId).map((a) => a.alias);

  // Models with aliases first, then by how usable they are, so the ones in use are at the top.
  const rank = (m: Model) => (boundTo(m).length ? 0 : m.status === "entitled" ? 1 : untested(m) ? (m.status === "listed" ? 4 : 2) : 3);
  const q = filter.trim().toLowerCase();
  const shown = rows
    .filter((m) => !q || `${m.displayName} ${m.providerModelId} ${m.route}`.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));

  function open(editing: ModelRow | null) {
    setFormError(null);
    setForm({ editing, value: editing ? formFor(editing) : emptyManual });
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    setFormError(null);
    try {
      const { editing, value } = form;
      if (editing) {
        const { id: _id, ...fields } = value;
        await api(`/models/${encodeURIComponent(c.id)}/${encodeURIComponent(editing.providerModelId)}`, {
          method: "PATCH",
          json: { ...fields, query: parseQuery(value.query), displayName: value.displayName, bodyModel: value.bodyModel },
        });
      } else {
        await api(`/connections/${c.id}/models`, { method: "POST", json: manualBody(value) });
      }
      setForm(null);
      await onChanged();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const testing = busy === c.id;
  return (
    <>
      <div className="toolbar">
        <button className={form ? "" : "primary"} onClick={() => onProbe()} disabled={busy !== null}>
          {testing ? "Testing…" : "Test models"}
        </button>
        <button onClick={() => onProbe({ includeListed: true })} disabled={busy !== null} title="Lists the provider's models and tests every one, including newly listed ones. May incur usage.">
          Scan inventory
        </button>
        <span className="spacer" />
        <button onClick={() => (form && !form.editing ? setForm(null) : open(null))} aria-expanded={!!form && !form.editing}>
          Add a model
        </button>
      </div>
      <p className="hint">Test models asks the provider for its list where it can, then sends each model you have a tiny request. Scan inventory also tests every listed model, which may incur usage.</p>

      {form && (
        <div className="subsection">
          <h4>{form.editing ? `Edit ${form.editing.displayName}` : "Add a model"}</h4>
          <ModelFields value={form.value} onChange={(value) => setForm({ ...form, value })} idLocked={!!form.editing} disabled={saving} baseUrl={c.baseUrl} />
          {formError && <div className="issue error">{formError}</div>}
          <div className="row">
            <button className="primary" onClick={save} disabled={!form.value.id.trim() || !form.value.route.trim() || saving}>
              {saving ? "Saving…" : form.editing ? "Save changes" : "Add model"}
            </button>
            <button className="ghost" disabled={saving} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
          <p className="hint">{form.editing ? "Saving clears this model's last result. Test it again afterwards." : "Test the model after adding it."}</p>
        </div>
      )}

      {rows.length > 8 && (
        <label className="field filter">
          <span>Filter models</span>
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name, id, or route" />
        </label>
      )}

      {rows.length ? (
        <table className="model-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Last test</th>
              <th>Aliases</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.id}>
                <td>
                  <div className="model-name">{m.displayName}</div>
                  <div className="mono muted model-route">
                    {m.providerModelId === m.displayName ? "" : `${m.providerModelId} on `}
                    {m.route}
                  </div>
                  <div className="muted small">{m.dialect === "anthropic.messages" ? "Anthropic Messages" : "OpenAI Chat Completions"}</div>
                </td>
                <td>
                  <span className={`badge ${m.status}`} title={STATUS_HELP[m.status]}>
                    {STATUS_LABEL[m.status] ?? m.status}
                  </span>
                  {m.statusMessage && (
                    <div className="result-detail" title={m.statusMessage}>
                      {m.statusMessage}
                    </div>
                  )}
                </td>
                <td>
                  <AliasCell aliases={boundTo(m)} canBind={!BROKEN.has(m.status)} onAdd={(a) => onSetAlias(a, m)} onDelete={onDeleteAlias} />
                </td>
                <td>
                  <div className="row tight end">
                    <button className="tiny" onClick={() => onProbeOne(m)} disabled={busy !== null}>
                      {busy === m.id ? "Testing…" : "Test"}
                    </button>
                    {m.origin === "manual" && (
                      <button className="tiny" disabled={saving} onClick={() => open(m)}>
                        Edit
                      </button>
                    )}
                    <button className="tiny ghost danger" onClick={() => onRemoveModel(m)} aria-label={`Remove ${m.displayName}`}>
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={4} className="muted">
                  No model matches the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <p className="empty">No models yet. Test models to list them, or add one by id.</p>
      )}
    </>
  );
}

/** Aliases on a model: chips to remove, and a small inline box to add one. */
function AliasCell({ aliases, canBind, onAdd, onDelete }: { aliases: string[]; canBind: boolean; onAdd(alias: string): void; onDelete(alias: string): void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const submit = () => {
    const a = name.trim();
    if (a) onAdd(a);
    setAdding(false);
    setName("");
  };
  return (
    <div className="alias-cell">
      {aliases.map((a) => (
        <AliasChip key={a} alias={a} onDelete={() => onDelete(a)} />
      ))}
      {canBind && !aliases.includes("default") && !adding && (
        <button className="tiny ghost" onClick={() => onAdd("default")}>
          Make default
        </button>
      )}
      {canBind &&
        (adding ? (
          <span className="alias-add">
            <input
              aria-label="New alias name"
              value={name}
              autoFocus
              placeholder="e.g. fast"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") setAdding(false);
              }}
            />
            <button className="tiny" onClick={submit} disabled={!name.trim()}>
              Add
            </button>
          </span>
        ) : (
          <button className="tiny ghost" onClick={() => setAdding(true)}>
            Add alias
          </button>
        ))}
    </div>
  );
}

/** Fix a provider in place: where requests go, how the key is sent, extra headers, and the key itself. */
function ConnectionForm({
  connection: c,
  sampleRoute,
  busy,
  onSaved,
  onRemove,
}: {
  connection: Connection;
  sampleRoute?: string;
  busy: boolean;
  onSaved(changed: string[]): Promise<void>;
  onRemove(): void;
}) {
  const initialRows = headerRows(c.extraHeaders);
  const [baseUrl, setBaseUrl] = useState(c.baseUrl);
  const [headerName, setHeaderName] = useState(c.auth.headerName);
  const [prefix, setPrefix] = useState(c.auth.prefix ?? "");
  const [rows, setRows] = useState<HeaderRow[]>(initialRows);
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setup } = useSetup();
  const storedIn = setup?.secrets === "os-keychain" ? "your OS keychain" : "an encrypted file in Rig's data folder";

  const headersChanged = JSON.stringify(rows.filter((r) => r.name || r.value)) !== JSON.stringify(initialRows);
  const changed = [
    baseUrl.trim() !== c.baseUrl && "the base URL",
    headerName.trim() !== c.auth.headerName && "the key header",
    prefix !== (c.auth.prefix ?? "") && "the key prefix",
    headersChanged && "the additional headers",
    key.trim() && "the key",
  ].filter((x): x is string => Boolean(x));
  const dirty = changed.length > 0;

  function discard() {
    setBaseUrl(c.baseUrl);
    setHeaderName(c.auth.headerName);
    setPrefix(c.auth.prefix ?? "");
    setRows(initialRows);
    setKey("");
    setError(null);
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (baseUrl.trim() !== c.baseUrl) body.baseUrl = baseUrl.trim();
      if (headerName.trim() !== c.auth.headerName) body.headerName = headerName.trim();
      if (prefix !== (c.auth.prefix ?? "")) body.headerPrefix = prefix;
      if (headersChanged) body.extraHeaders = headerRecord(rows);
      if (key.trim()) body.key = key.trim();
      await api<Connection>(`/connections/${c.id}`, { method: "PATCH", json: body });
      setKey("");
      await onSaved(changed);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="connection-form">
      <label className="field">
        <span>Base URL</span>
        <input className="mono-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} autoComplete="off" />
        <span className="hint">
          Where requests go. Each model's route is added to it.
          {sampleRoute && (
            <>
              {" "}
              A request now goes to <span className="mono url-preview">{joinUrl(baseUrl.trim(), sampleRoute)}</span>
            </>
          )}
        </span>
      </label>

      <label className="field">
        <span>Key</span>
        <div className="row nowrap">
          <input
            className="grow"
            type={reveal ? "text" : "password"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder={`Unchanged, ends ${c.secretLast4}`}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="ghost" onClick={() => setReveal(!reveal)}>
            {reveal ? "Hide" : "Show"}
          </button>
        </div>
        <span className="hint">Leave blank to keep the current key. A new key replaces it in {storedIn}.</span>
      </label>

      <div className="grid2">
        <label className="field">
          <span>Header for the key</span>
          <input value={headerName} onChange={(e) => setHeaderName(e.target.value)} spellCheck={false} />
          <span className="hint">For example Authorization, x-api-key, or Ocp-Apim-Subscription-Key.</span>
        </label>
        <label className="field">
          <span>Text before the key (optional)</span>
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="None" spellCheck={false} />
          <span className="hint">
            Sent as <span className="mono">{`${headerName.trim() || "header"}: ${prefix}…`}</span>
          </span>
        </label>
      </div>

      <HeaderFields rows={rows} onChange={setRows} />

      {error && (
        <div className="issue error" role="alert">
          {error}
        </div>
      )}
      <div className="row">
        <button className="primary" onClick={save} disabled={!dirty || saving || busy}>
          {saving ? "Saving…" : "Save and test"}
        </button>
        {dirty && (
          <button className="ghost" onClick={discard} disabled={saving}>
            Discard changes
          </button>
        )}
      </div>
      <p className="hint">
        {dirty ? `Changes ${changed.join(", ")}. ` : ""}Models, aliases, and agents stay as they are. Saving clears earlier test results and tests the models again.
      </p>

      <div className="danger-zone">
        <h4>Name</h4>
        <p className="hint">
          <span className="mono">{c.name}</span>. Agents refer to this provider by name, so it stays fixed. For a different name, add a new provider.
        </p>
        <h4>Remove this provider</h4>
        <p className="hint">Deletes its key and its models. Agents bound to its models stop working.</p>
        <button className="danger" onClick={onRemove}>
          Remove {c.name}
        </button>
      </div>
    </div>
  );
}

/** The add-a-provider form, in rig-probe's shape: a preset first, then only the fields it needs. */
function AddProvider({ profiles, existing, onAdded, onCancel }: { profiles: GatewayProfile[]; existing: Connection[]; onAdded(c: Connection, named: boolean): void; onCancel?: () => void }) {
  const [profileId, setProfileId] = useState("");
  // null follows the preset's suggestion; true or false once the user picks.
  const [nameModel, setNameModel] = useState<boolean | null>(null);
  const [model, setModel] = useState<ManualForm>(emptyManual);
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [headerName, setHeaderName] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
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
  // A gateway template's built-in routes are examples, so naming the real model is the usual path there.
  const named = nameModel ?? Boolean(profile?.template && !local);
  const needsModel = named && (!model.id.trim() || !model.route.trim());
  const blocked = busy || (!key && !local) || needsUrl || needsModel;

  async function submit() {
    if (!profile || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ connection: Connection }>("/connections", {
        method: "POST",
        json: {
          name: name.trim() || suggested,
          profileId: profile.id,
          key: key || (local ? "local" : ""),
          baseUrl: baseUrl.trim() || undefined,
          headerName: headerName.trim() || undefined,
          extraHeaders: headerRecord(headers),
          models: named ? [manualBody(model)] : undefined,
        },
      });
      setKey("");
      onAdded(res.connection, named);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return null;
  const sentAs = `${headerName.trim() || profile.auth.headerName}: ${profile.auth.prefix ?? ""}…`;

  return (
    <section className="add-provider">
      <h3>Add a provider</h3>
      <ol className="steps">
        <li>
          <div className="step-title">Choose where the models run</div>
          <select
            value={profile.id}
            onChange={(e) => {
              setProfileId(e.target.value);
              setNameModel(null);
            }}
            aria-label="Provider"
          >
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
              <span className="hint">{local ? "Where the server listens. The address shown is the usual one." : "Your gateway's URL, without the route. You can correct it later under Connection."}</span>
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
                onKeyDown={(e) => e.key === "Enter" && submit()}
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
                <span className="hint">How this provider appears in Rig. Agents refer to it by this name, so it cannot be changed later.</span>
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
            <HeaderFields rows={headers} onChange={setHeaders} />
          </details>
        </li>
        <li>
          <div className="step-title">Choose the model</div>
          <div className="checks" role="radiogroup" aria-label="How Rig finds the model">
            <label>
              <input type="radio" name="model-source" checked={!named} onChange={() => setNameModel(false)} /> Find the models for me
            </label>
            <label>
              <input type="radio" name="model-source" checked={named} onChange={() => setNameModel(true)} /> I'll name the model and its route
            </label>
          </div>
          {named ? (
            <>
              <p className="hint">Use this when the gateway needs a specific route, deployment, or query parameter for each model. You can add more models later.</p>
              <ModelFields value={model} onChange={setModel} disabled={busy} baseUrl={baseUrl.trim() || profile.baseUrl} />
            </>
          ) : (
            <p className="hint">Rig asks the provider for its model list where it can, and tests the models it already knows.{profile.template ? " This preset's built-in routes are examples; if your gateway uses different ones, name the model instead." : ""}</p>
          )}
        </li>
        <li>
          <div className="step-title">Connect and test</div>
          <p className="hint">
            {named
              ? "Rig sends this model a tiny request (a few tokens), so you see whether the key can reach it before anything depends on it."
              : "Rig sends each known model a tiny request (a few tokens), so you see which ones the key can reach before anything depends on them."}
          </p>
          {error && <div className="issue error">{error}</div>}
          <div className="row">
            <button className="primary" onClick={submit} disabled={blocked}>
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

/** The fields that describe one model's request: id, dialect, route, and gateway extras. */
function ModelFields({ value, onChange, idLocked, disabled, baseUrl }: { value: ManualForm; onChange(v: ManualForm): void; idLocked?: boolean; disabled?: boolean; baseUrl?: string }) {
  const set = (patch: Partial<ManualForm>) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="grid2">
        <label className="field">
          <span>Model id</span>
          <input value={value.id} disabled={idLocked || disabled} onChange={(e) => set({ id: e.target.value })} placeholder="e.g. claude-sonnet or llama3.1:8b" spellCheck={false} />
          <span className="hint">
            {idLocked
              ? "The id stays fixed so agents and aliases keep working. Change the deployment in Route, or the request model below."
              : "Sent in the request body unless you override it below."}
          </span>
        </label>
        <label className="field">
          <span>Display name (optional)</span>
          <input value={value.displayName} disabled={disabled} onChange={(e) => set({ displayName: e.target.value })} />
        </label>
        <label className="field">
          <span>Dialect</span>
          <select value={value.dialect} disabled={disabled} onChange={(e) => set({ dialect: e.target.value })}>
            <option value="openai.chat">OpenAI Chat Completions</option>
            <option value="anthropic.messages">Anthropic Messages</option>
          </select>
        </label>
        <label className="field">
          <span>Route</span>
          <input value={value.route} disabled={disabled} onChange={(e) => set({ route: e.target.value })} placeholder={value.dialect === "openai.chat" ? "/v1/chat/completions" : "/v1/messages"} spellCheck={false} />
          <span className="hint">
            The path added to the base URL.
            {baseUrl && value.route.trim() && (
              <>
                {" "}
                Requests go to <span className="mono url-preview">{joinUrl(baseUrl, value.route.trim())}</span>
              </>
            )}
          </span>
        </label>
        <label className="field">
          <span>Model id in the body (optional)</span>
          <input value={value.bodyModel} disabled={disabled} onChange={(e) => set({ bodyModel: e.target.value })} spellCheck={false} />
          <span className="hint">For gateways whose deployment name differs from the model id.</span>
        </label>
        {value.dialect === "openai.chat" && (
          <label className="field">
            <span>Max tokens field</span>
            <select value={value.maxTokensField} disabled={disabled} onChange={(e) => set({ maxTokensField: e.target.value })}>
              <option value="max_tokens">max_tokens</option>
              <option value="max_completion_tokens">max_completion_tokens (newer OpenAI models)</option>
            </select>
          </label>
        )}
        <label className="field checks">
          <input type="checkbox" checked={value.reasoning} disabled={disabled} onChange={(e) => set({ reasoning: e.target.checked })} /> Supports a reasoning effort setting
        </label>
      </div>
      <label className="field">
        <span>Query parameters (JSON, string values)</span>
        <textarea value={value.query} disabled={disabled} onChange={(e) => set({ query: e.target.value })} placeholder={'{"api-version":"2024-12-01-preview"}'} spellCheck={false} />
        <span className="hint">Use {"{}"} for none. These override matching query parameters in Route.</span>
      </label>
    </>
  );
}
