import { useEffect, useRef, useState } from "react";
import { api } from "./api";

interface FolderListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
}

export function FolderPicker({ initialPath, onSelect, onClose }: {
  initialPath: string;
  onSelect(path: string): void;
  onClose(): void;
}) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  async function browse(folder?: string) {
    const id = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api<FolderListing>(`/folders${folder ? `?path=${encodeURIComponent(folder)}` : ""}`);
      if (id === request.current) setListing(result);
    } catch (e) {
      if (id === request.current) setError((e as Error).message);
    } finally {
      if (id === request.current) setBusy(false);
    }
  }

  useEffect(() => {
    void browse(initialPath || undefined);
    return () => { request.current++; };
  }, [initialPath]);

  return <div className="card" role="region" aria-label="Choose project folder" style={{ marginBottom: 10, padding: 10 }}>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <button type="button" disabled={busy} onClick={() => browse()}>Home</button>
      <button type="button" disabled={busy || !listing?.parent} onClick={() => browse(listing?.parent ?? undefined)}>Up</button>
      <button type="button" onClick={onClose}>Close</button>
    </div>
    <p className="muted" style={{ fontSize: 12 }}>Folders on the machine running Rig. Files stay in place.</p>
    {listing && <div className="mono" style={{ overflowWrap: "anywhere", fontSize: 12, marginBottom: 6 }}>{listing.path}</div>}
    {error && <div role="alert" className="issue error">{error}</div>}
    {busy && <div role="status">Loading folders…</div>}
    <div style={{ maxHeight: 220, overflowY: "auto" }}>
      {listing?.entries.map((entry) => <button type="button" key={entry.path} disabled={busy} onClick={() => browse(entry.path)} style={{ display: "block", width: "100%", textAlign: "left", marginBottom: 3, overflowWrap: "anywhere" }}>
        📁 {entry.name}
      </button>)}
      {listing && !listing.entries.length && !busy && <div className="muted">No subfolders.</div>}
    </div>
    {listing?.truncated && <p className="muted">Large folder: only part of the listing is shown. You can still enter a path in the workspace field.</p>}
    <button type="button" className="primary" disabled={busy || !listing || !!error} onClick={() => listing && onSelect(listing.path)} style={{ marginTop: 8, width: "100%" }}>Use this folder</button>
  </div>;
}
