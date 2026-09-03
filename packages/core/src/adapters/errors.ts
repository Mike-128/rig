import type { HarnessError, HarnessErrorKind } from "../types";

export function errorFromStatus(status: number | undefined, message: string): HarnessError {
  let kind: HarnessErrorKind = "unknown";
  let retryable = false;
  if (status === 401) kind = "auth";
  else if (status === 403) kind = "forbidden";
  else if (status === 404) kind = "not_found";
  else if (status === 400 || status === 413 || status === 422) kind = "invalid_request";
  else if (status === 429) {
    kind = "rate_limit";
    retryable = true;
  } else if (status !== undefined && status >= 500) {
    kind = "server";
    retryable = true;
  }
  return { kind, message, status, retryable };
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (("name" in err && (err as { name?: string }).name === "AbortError") ||
      ("message" in err && /abort/i.test(String((err as { message?: string }).message))))
  );
}

export function cancelledError(): HarnessError {
  return { kind: "cancelled", message: "Cancelled", retryable: false };
}

export function networkError(message: string): HarnessError {
  return { kind: "network", message, retryable: true };
}
