import type { HarnessError, HarnessErrorKind } from "../types";

/** SDKs render an empty error body as e.g. "429 status code (no body)", which tells a user nothing. */
const BARE_STATUS = /^\d{3} status code \(no body\)\.?$/i;

function humanize(status: number | undefined, message: string): string {
  if (!BARE_STATUS.test(message.trim())) return message;
  switch (status) {
    case 401:
      return "The provider rejected the key (401). Check the key and the auth header for this connection.";
    case 403:
      return "The provider refused access to this model (403). The key may not be entitled to it.";
    case 404:
      return "The provider does not recognise this model or route (404). Check the model id and its route.";
    case 429:
      return "Rate limited by the provider (429), with no detail returned. Wait a moment and retry, or use a model with more quota.";
    default:
      return status !== undefined && status >= 500
        ? `The provider returned ${status} with no error body. This is usually transient.`
        : `The provider returned ${status ?? "an error"} with no error body.`;
  }
}

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
  return { kind, message: humanize(status, message), status, retryable };
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
