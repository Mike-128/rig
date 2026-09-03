import type { RunEvent } from "@rig/core";

export const BASE = (process.env.RIG_URL ?? "http://127.0.0.1:7777").replace(/\/+$/, "");

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  let body = init?.body;
  if (init?.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, { ...init, headers, body });
  } catch (e) {
    throw new Error(`Cannot reach the runtime at ${BASE}. Start it with "rig serve" (or pnpm dev:runtime). ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* plain */
  }
  if (!res.ok) {
    const d = data as { error?: string; issues?: { path: string; message: string }[] };
    const detail = d?.issues?.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(d?.error ? `${d.error}${detail ? ` (${detail})` : ""}` : `${res.status} ${res.statusText}`);
  }
  return data as T;
}

/** Consume a Server-Sent Events stream, calling onEvent per event until the stream closes or the callback returns false. */
export async function sse(path: string, onEvent: (ev: RunEvent) => boolean | void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/api${path}`, { headers: { accept: "text/event-stream" }, signal });
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const stop = onEvent(JSON.parse(data) as RunEvent);
        if (stop === false) {
          await reader.cancel();
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
