import { useEffect, useState } from "react";
import type { Connection, ListModelsSpec } from "@rig/core/types";
import { api } from "./api";
export type HeaderRow = { name: string; value: string };
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
export function HeaderFields({ rows, onChange }: { rows: HeaderRow[]; onChange(rows: HeaderRow[]): void }) {
  return <div><h4>Additional request headers</h4>
    <p className="muted">Applied to listing, probes, and every model call. Use for non-secret metadata such as a charge code. Values are saved in local connection settings; keep credentials in the Key field.</p>
    <table><thead><tr><th>Header field</th><th>Value</th><th></th></tr></thead><tbody>
      {rows.map((row, i) => <tr key={i}>
        <td><input aria-label={`Header field ${i + 1}`} value={row.name} placeholder="x-company-charge-code" onChange={(e) => onChange(rows.map((r, n) => n === i ? { ...r, name: e.target.value } : r))} /></td>
        <td><input aria-label={`Header value ${i + 1}`} value={row.value} onChange={(e) => onChange(rows.map((r, n) => n === i ? { ...r, value: e.target.value } : r))} /></td>
        <td><button onClick={() => onChange(rows.filter((_, n) => n !== i))}>Remove header</button></td></tr>)}
    </tbody></table><button onClick={() => onChange([...rows, { name: "", value: "" }])}>Add header</button></div>;
}
export function ConnectionSettings({ connection, onSaved, onClose }: { connection: Connection; onSaved(): Promise<void>; onClose(): void }) {
  const [rows, setRows] = useState<HeaderRow[]>(Object.entries(connection.extraHeaders ?? {}).map(([name, value]) => ({ name, value })));
  const [spec, setSpec] = useState({ dialect: "openai.chat", responseFormat: "provider", route: "", defaultRoute: "" });
  const [loaded, setLoaded] = useState(false);
  const [maxTokensField, setMaxTokensField] = useState("max_tokens");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/connections/${encodeURIComponent(connection.id)}`;
  useEffect(() => {
    let live = true;
    api<{ effective: ListModelsSpec | null }>(`${endpoint}/discovery`).then((result) => {
      if (!live) return;
      if (result.effective) setSpec({ dialect: result.effective.dialect, responseFormat: result.effective.responseFormat ?? "provider", route: result.effective.route, defaultRoute: result.effective.defaultRoute });
      setMaxTokensField(result.effective?.defaultParams?.maxTokensField ?? "max_tokens");
      setLoaded(true);
    }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [endpoint]);
  async function save(kind: "headers" | "discovery" | "reset") {
    setBusy(true); setError(""); setNotice("");
    try {
      await api(`${endpoint}/${kind === "headers" ? "headers" : "discovery"}`, { method: kind === "headers" ? "PATCH" : "PUT", json: kind === "headers" ? headerRecord(rows) : kind === "reset" ? null : { ...spec, defaultParams: { maxTokensField } } });
      await onSaved();
      setNotice(kind === "headers" ? "Headers saved. Previous probe results cleared; probe again." : kind === "reset" ? "Profile defaults restored. Reopen settings to view them." : "Discovery saved. Use Scan inventory to list and probe.");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="card"><h3>Connection settings</h3>
    {error && <div className="issue error">{error}</div>}{notice && <div className="issue">{notice}</div>}
    <HeaderFields rows={rows} onChange={setRows} /><button disabled={busy} onClick={() => save("headers")}>Save headers</button>
    <h4>Model discovery</h4><p className="muted">Use the listing path supplied by your gateway administrator and select its response format. One configuration covers one inference dialect. Deployment inventories import successful OpenAI deployments explicitly marked as chat-capable; access/entitlement lists alone may not contain routing information.</p>
    <label className="field"><span>Listing response format</span><select value={spec.responseFormat} onChange={(e) => setSpec({ ...spec, responseFormat: e.target.value, dialect: e.target.value === "azure-deployments" ? "openai.chat" : spec.dialect })}><option value="provider">Provider model list</option><option value="azure-deployments">Azure deployment inventory</option></select></label>
    <label className="field"><span>Listing dialect</span><select value={spec.dialect} onChange={(e) => setSpec({ ...spec, dialect: e.target.value })}><option value="openai.chat">OpenAI-compatible</option><option value="anthropic.messages">Anthropic Messages</option></select></label>
    <label className="field"><span>Model listing route (GET, relative to base URL)</span><input value={spec.route} placeholder="/v1/models" onChange={(e) => setSpec({ ...spec, route: e.target.value })} /></label>
    <label className="field"><span>Inference route for newly discovered models</span><input value={spec.defaultRoute} placeholder="/v1/chat/completions" onChange={(e) => setSpec({ ...spec, defaultRoute: e.target.value })} /><span className="muted">May include an API-version query and {"{model}"} if listed IDs match deployment IDs. Existing models keep their routes.</span></label>
    <label className="field"><span>Max tokens field for new models (OpenAI dialect)</span><select value={maxTokensField} onChange={(e) => setMaxTokensField(e.target.value)}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
    <button disabled={busy || !loaded || !spec.route || !spec.defaultRoute} onClick={() => save("discovery")}>Save discovery</button>{" "}
    <button disabled={busy || !loaded} onClick={() => save("reset")}>Use profile defaults</button>{" "}
    <button disabled={busy} onClick={onClose}>Close settings</button></div>;
}
