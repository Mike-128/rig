import { useEffect, useRef, useState } from "react";
import { api } from "./api";

interface FolderListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
}

/** Browse folders on the machine running Rig; picking one does not grant an agent anything by itself. */
export function FolderPicker({ initialPath, onSelect, onClose }: { initialPath: string; onSelect(path: string): void; onClose(): void }) {
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
    return () => {
      request.current++;
    };
  }, [initialPath]);

  return (
    <div className="folder-picker" role="region" aria-label="Choose project folder">
      <div className="row">
        <button type="button" className="tiny" disabled={busy} onClick={() => browse()}>
          Home
        </button>
        <button type="button" className="tiny" disabled={busy || !listing?.parent} onClick={() => browse(listing?.parent ?? undefined)}>
          Up
        </button>
        {listing && <span className="mono muted grow folder-path">{listing.path}</span>}
        <button type="button" className="tiny ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {error && (
        <div role="alert" className="issue error">
          {error}
        </div>
      )}
      <div className="folder-list">
        {busy && !listing && <div className="muted small pad">Loading folders…</div>}
        {listing?.entries.map((entry) => (
          <button type="button" key={entry.path} className="folder-entry" disabled={busy} onClick={() => browse(entry.path)}>
            {entry.name}
          </button>
        ))}
        {listing && !listing.entries.length && !busy && <div className="muted small pad">No subfolders.</div>}
      </div>
      {listing?.truncated && <p className="hint">Large folder: only part of the listing is shown. You can still type a path.</p>}
      <div className="row end">
        <span className="hint grow">Folders on the machine running Rig. Files stay in place.</span>
        <button type="button" disabled={busy || !listing || !!error} onClick={() => listing && onSelect(listing.path)}>
          Use this folder
        </button>
      </div>
    </div>
  );
}
