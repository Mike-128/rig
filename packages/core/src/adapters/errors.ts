import type { RigError, RigErrorKind } from "../types";

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

export function errorFromStatus(status: number | undefined, message: string): RigError {
  let kind: RigErrorKind = "unknown";
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

export function cancelledError(): RigError {
  return { kind: "cancelled", message: "Cancelled", retryable: false };
}

export function networkError(message: string): RigError {
  return { kind: "network", message, retryable: true };
}

/** Set by Rig's local proxy on a response it made itself because the gateway could not be reached. */
export const PROXY_ERROR_HEADER = "x-rig-proxy-error";

/** True for the proxy's own "could not connect" answer, which is not an HTTP answer from the provider. */
export function isProxyConnectionError(headers: unknown): boolean {
  if (!headers) return false;
  const h = headers as { get?: (name: string) => string | null } & Record<string, unknown>;
  const value = typeof h.get === "function" ? h.get(PROXY_ERROR_HEADER) : h[PROXY_ERROR_HEADER];
  return value === "unreachable";
}

/** The message inside the proxy's answer, without the SDK's "502 {json}" wrapping. */
function proxyMessage(err: { message: string; error?: unknown }): string {
  const e = err.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  const inner = e?.error?.message ?? e?.message;
  return typeof inner === "string" ? inner : err.message.replace(/^\d{3}\s+/, "");
}

function header(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const h = headers as { get?: (name: string) => string | null } & Record<string, unknown>;
  const value = typeof h.get === "function" ? h.get(name) : h[name];
  return typeof value === "string" && value ? value : undefined;
}

const HTML_PAGE = /<\s*(!doctype\s+html|html|head|body)\b/i;
/** Azure Front Door's request reference, shown on its block page and sent as x-azure-ref. */
const AZURE_REF = /\b\d{8}T\d{6}Z-[A-Za-z0-9]{12,}\b/;

function pageText(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Some answers are web pages rather than API errors: a firewall, load balancer, or proxy in front
 * of the provider answered instead of the provider. Say that plainly, quote the page's own
 * headline instead of its markup, and keep any reference id the operators can look up.
 */
export function describeHtmlError(status: number | undefined, message: string, headers?: unknown): string | undefined {
  if (!HTML_PAGE.test(message)) return undefined;
  const pick = (re: RegExp) => {
    const m = re.exec(message);
    return m ? pageText(m[1]) : "";
  };
  const headline = pick(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || pick(/<title[^>]*>([\s\S]*?)<\/title>/i) || pageText(message.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")).replace(/^\d{3}\s+/, "").slice(0, 160);
  const ref = header(headers, "x-azure-ref") ?? AZURE_REF.exec(message)?.[0] ?? header(headers, "x-request-id") ?? header(headers, "x-ms-request-id");
  const code = status !== undefined ? ` (${status})` : "";
  const quoted = headline ? ` Its page says: "${headline}"` : "";
  const blocked = status === 403 && /block|denied|forbidden|firewall|reject/i.test(headline || message);
  const lead = blocked
    ? `A firewall in front of the provider blocked this request${code}; it did not reach the model.${quoted}`
    : `Something in front of the provider (a gateway, proxy, or firewall) answered${code} with a web page instead of an API error.${quoted}`;
  const tail = ref
    ? ` Reference: ${ref}. Whoever runs the gateway can look this reference up in the firewall or gateway logs to see which rule matched.`
    : blocked
      ? " Ask whoever runs the gateway which firewall rule matched, and give them the time of the request."
      : "";
  return `${lead}${tail}`;
}

/** A provider error from the SDK, or Rig's own "could not connect" answer, as a RigError. */
export function apiError(err: { status?: number; message: string; headers?: unknown; error?: unknown }): RigError {
  if (isProxyConnectionError(err.headers)) return networkError(proxyMessage(err));
  const page = describeHtmlError(err.status, err.message, err.headers);
  return errorFromStatus(err.status, page ?? err.message);
}

/**
 * The SDKs report every failure to connect as "Connection error.", and keep the reason (DNS,
 * refused, timeout, certificate) in a chain of causes. Bring the reason up so it can be shown.
 */
export function connectionFailure(err: unknown): RigError {
  const top = err instanceof Error ? err.message : String(err);
  const parts: string[] = [];
  let cause: unknown = err;
  for (let depth = 0; cause && depth < 6; depth++) {
    const c = cause as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof c.code === "string" && !parts.includes(c.code)) parts.push(c.code);
    if (depth > 0 && typeof c.message === "string" && c.message && c.message !== top && !parts.some((p) => c.message === p)) parts.push(c.message);
    cause = c.cause;
  }
  return networkError(parts.length ? `${top.replace(/\.$/, "")}: ${parts.join(", ")}` : top);
}
