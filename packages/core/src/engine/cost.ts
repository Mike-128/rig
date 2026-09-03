import type { Pricing, Usage } from "../types";

/** Estimated USD for one usage record. Cached input is billed at the cached rate when known. */
export function estimateCost(usage: Usage, pricing?: Pricing): number {
  if (!pricing) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const uncached = Math.max(usage.inputTokens - cached, 0);
  const per = 1_000_000;
  const cachedRate = pricing.cachedInput ?? pricing.input;
  return (uncached * pricing.input + cached * cachedRate + usage.outputTokens * pricing.output) / per;
}
