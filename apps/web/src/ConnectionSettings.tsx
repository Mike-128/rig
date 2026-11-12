import { useEffect, useState } from "react";
import type { Connection, ListModelsSpec } from "@rig/core/types";
import { api } from "./api";

export type HeaderRow = { name: string; value: string };

export function headerRows(headers: Record<string, string> | undefined): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

export function headerRecord(rows: HeaderRow[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const row of rows) {
    const name = row.name.trim().toLowerCase();
    if (!name && !row.value) continue;
    if (!name) throw new Error("Enter a name for each header value.");
    if (Object.hasOwn(result, name)) throw new Error("Header names must be unique.");
    result[name] = row.value;
  }
  return result;
}

/** Non-secret metadata headers sent with every request, edited as rows. */
export function HeaderFields({ rows, onChange }: { rows: HeaderRow[]; onChange(rows: HeaderRow[]): void }) {
  const set = (i: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <div className="header-fields">
      <h4>Additional request headers</h4>
      <p className="hint">Sent with listing, tests, and every model call. Use them for non-secret metadata such as a charge code. They are saved in local settings, so keep credentials in the Key field.</p>
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Header</th>
              <th>Value</th>
              <th>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td>
                  <input aria-label={`Header ${i + 1} name`} value={row.name} placeholder="x-company-charge-code" spellCheck={false} onChange={(e) => set(i, { name: e.target.value })} />
                </td>
                <td>
                  <input aria-label={`Header ${i + 1} value`} value={row.value} spellCheck={false} onChange={(e) => set(i, { value: e.target.value })} />
                </td>
                <td className="end-cell">
                  <button className="tiny ghost danger" aria-label={`Remove header ${row.name || i + 1}`} onClick={() => onChange(rows.filter((_, n) => n !== i))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="tiny" onClick={() => onChange([...rows, { name: "", value: "" }])}>
        Add a header
      </button>
    </div>
  );
}

/** How Rig lists a provider's models: the listing route, its format, and routes for what it finds. */
export function DiscoverySettings({ connection, onSaved }: { connection: Connection; onSaved(): Promise<unknown> }) {
  const [spec, setSpec] = useState({ dialect: "openai.chat", responseFormat: "provider", route: "", defaultRoute: "" });
  const [maxTokensField, setMaxTokensField] = useState("max_tokens");
  const [custom, setCustom] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/connections/${encodeURIComponent(connection.id)}/discovery`;

  async function load() {
    const result = await api<{ override: ListModelsSpec | null; effective: ListModelsSpec | null }>(endpoint);
    const e = result.effective;
    if (e) setSpec({ dialect: e.dialect, responseFormat: e.responseFormat ?? "provider", route: e.route, defaultRoute: e.defaultRoute });
    setMaxTokensField(e?.defaultParams?.maxTokensField ?? "max_tokens");
    setCustom(Boolean(result.override));
    setLoaded(true);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [endpoint]);

  async function save(reset: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(endpoint, { method: "PUT", json: reset ? null : { ...spec, defaultParams: { maxTokensField } } });
      await load();
      await onSaved();
      setNotice(reset ? "Restored the provider's defaults." : "Saved. Use Scan inventory on the Models tab to list and test.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="discovery">
      <p className="hint">
        How Rig asks this provider which models it has. {custom ? "These are your settings for this provider." : "These are the provider's defaults."} Use the listing path from your gateway administrator. One configuration covers one dialect. Deployment inventories import OpenAI deployments marked
        as chat-capable; a list of entitlements alone may not include routes.
      </p>
      <div className="grid2">
        <label className="field">
          <span>Listing response format</span>
          <select value={spec.responseFormat} onChange={(e) => setSpec({ ...spec, responseFormat: e.target.value, dialect: e.target.value === "azure-deployments" ? "openai.chat" : spec.dialect })}>
            <option value="provider">Provider model list</option>
            <option value="azure-deployments">Azure deployment inventory</option>
          </select>
        </label>
        <label className="field">
          <span>Dialect of listed models</span>
          <select value={spec.dialect} onChange={(e) => setSpec({ ...spec, dialect: e.target.value })}>
            <option value="openai.chat">OpenAI-compatible</option>
            <option value="anthropic.messages">Anthropic Messages</option>
          </select>
        </label>
        <label className="field">
          <span>Listing route (GET, added to the base URL)</span>
          <input value={spec.route} placeholder="/v1/models" spellCheck={false} onChange={(e) => setSpec({ ...spec, route: e.target.value })} />
        </label>
        <label className="field">
          <span>Max tokens field for new models</span>
          <select value={maxTokensField} onChange={(e) => setMaxTokensField(e.target.value)}>
            <option value="max_tokens">max_tokens</option>
            <option value="max_completion_tokens">max_completion_tokens</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Route for models found by listing</span>
        <input value={spec.defaultRoute} placeholder="/v1/chat/completions" spellCheck={false} onChange={(e) => setSpec({ ...spec, defaultRoute: e.target.value })} />
        <span className="hint">May include an API-version query, and {"{model}"} where the listed id is the deployment name. Models you already have keep their routes.</span>
      </label>
      {error && <div className="issue error">{error}</div>}
      {notice && <div className="issue ok">{notice}</div>}
      <div className="row">
        <button className="primary" disabled={busy || !loaded || !spec.route || !spec.defaultRoute} onClick={() => save(false)}>
          Save discovery
        </button>
        {custom && (
          <button className="ghost" disabled={busy} onClick={() => save(true)}>
            Restore defaults
          </button>
        )}
      </div>
    </div>
  );
}
