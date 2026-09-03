import type { Dialect } from "../types";
import { anthropicAdapter } from "./anthropic";
import { openaiAdapter } from "./openai";
import type { ProviderAdapter } from "./types";

const ADAPTERS: Record<Dialect, ProviderAdapter> = {
  "anthropic.messages": anthropicAdapter,
  "openai.chat": openaiAdapter,
};

export function adapterFor(dialect: Dialect): ProviderAdapter {
  const a = ADAPTERS[dialect];
  if (!a) throw new Error(`No adapter for dialect ${dialect}`);
  return a;
}

export type { ProviderAdapter, AdapterConnection } from "./types";
export { anthropicAdapter, openaiAdapter };
