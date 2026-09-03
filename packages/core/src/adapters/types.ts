import type { CanonicalRequest, Dialect, HarnessError, Model, StreamEvent } from "../types";
import type { ProbeResult } from "../gateway/probe";

/** How an adapter reaches a model: through the loopback proxy, never with the real key. */
export interface AdapterConnection {
  /** Base URL the vendor SDK is pointed at (the proxy, scoped to a connection). */
  baseUrl: string;
  /** Headers the proxy requires (loopback token). */
  headers: Record<string, string>;
  /** Value for the request body's model field, as the proxy expects it. */
  modelId: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ProviderAdapter {
  dialect: Dialect;
  stream(req: CanonicalRequest, conn: AdapterConnection, model: Model, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  probe(conn: AdapterConnection, model: Model, signal?: AbortSignal): Promise<ProbeResult>;
  listModels(conn: AdapterConnection, signal?: AbortSignal): Promise<string[]>;
  normalizeError(err: unknown): HarnessError;
}
