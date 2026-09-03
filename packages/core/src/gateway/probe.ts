import type { EntitlementStatus, RigError } from "../types";

export interface ProbeResult {
  status: EntitlementStatus;
  message?: string;
  latencyMs: number;
}

/**
 * Classify a probe outcome. A validation error (400) still proves the key reached the model,
 * so it counts as entitled. 401/403/404 do not.
 */
export function classifyProbeError(err: RigError): EntitlementStatus {
  switch (err.kind) {
    case "auth":
      return "unauthorized";
    case "forbidden":
      return "forbidden";
    case "not_found":
      return "not_found";
    case "rate_limit":
      return "rate_limited";
    case "invalid_request":
      return "entitled";
    case "server":
    case "network":
    case "cancelled":
    case "unknown":
    default:
      return "unknown";
  }
}
