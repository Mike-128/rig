import { describeHtmlError } from "../adapters/errors";

/**
 * Turns a model test's raw outcome (status, HTTP code, provider message) into what actually
 * happened and what to do about it. Pure, so the web UI and the CLI can both use it.
 */

export interface TestOutcome {
  status: string;
  statusCode?: number;
  statusMessage?: string;
  dialect?: string;
}

/** Where the request went and how it was authenticated, for explanations that name them. */
export interface TestContext {
  /** Header the key is sent in, e.g. Authorization or Ocp-Apim-Subscription-Key. */
  authHeader?: string;
  /** Names of the additional headers sent with every request. */
  extraHeaders?: string[];
  /** The full URL the test request went to. */
  url?: string;
}

export interface TestExplanation {
  /** "HTTP 400 Bad Request", or "No answer" when nothing came back. */
  code: string;
  /** What happened, in one or two plain sentences. */
  meaning: string;
  /** What to change, when there is something to change. */
  action?: string;
  /** The provider's own words, cleaned of SDK noise. */
  providerSaid?: string;
  latencyMs?: number;
  /** ok: it worked. warn: reached the model but something is off. bad: it did not work. */
  tone: "ok" | "warn" | "bad";
}

const REASON: Record<number, string> = {
  200: "OK",
  201: "Created",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  529: "Overloaded",
};

const IMPLIED_CODE: Record<string, number> = { unauthorized: 401, forbidden: 403, not_found: 404, rate_limited: 429 };

export function httpLabel(code: number | undefined): string {
  return code === undefined ? "No answer" : `HTTP ${code}${REASON[code] ? ` ${REASON[code]}` : ""}`;
}

/** Splits "<message> (123 ms)" into its parts, and digs the human message out of an SDK error string. */
export function parseTestMessage(raw: string | undefined): { said?: string; latencyMs?: number } {
  if (!raw) return {};
  let text = raw.trim();
  let latencyMs: number | undefined;
  const ms = text.match(/(?:^|\s)\(?(\d+) ms\)?$/);
  if (ms) {
    latencyMs = Number(ms[1]);
    text = text.slice(0, ms.index).trim();
  }
  if (!text) return { latencyMs };
  // SDK errors read "400 {json}" or "400 message"; keep the message.
  const status = text.match(/^(\d{3})\s/)?.[1];
  text = text.replace(/^\d{3}\s+/, "");
  // A web page from a firewall or proxy: its headline and reference, not its markup.
  const page = describeHtmlError(status ? Number(status) : undefined, text);
  if (page) return { said: page, latencyMs };
  const json = text.indexOf("{");
  if (json >= 0) {
    try {
      const body = JSON.parse(text.slice(json)) as Record<string, any>;
      const inner = body?.error?.message ?? body?.message ?? body?.error?.code ?? (typeof body?.error === "string" ? body.error : undefined) ?? body?.detail;
      if (typeof inner === "string" && inner.trim()) text = inner.trim();
    } catch {
      /* not JSON after all */
    }
  }
  return { said: text, latencyMs };
}

const has = (text: string, re: RegExp) => re.test(text);

/** A header name the provider says is missing or required, if it names one. */
function missingHeader(said: string): string | undefined {
  const patterns = [
    /(?:missing|required)[^.]*?\bheader\b[\s:'"`]*([A-Za-z0-9-]{2,})/i,
    /\bheader[\s:'"`]+([A-Za-z0-9-]{2,})['"`]?\s+(?:is\s+)?(?:missing|required)/i,
    /['"`]([A-Za-z][A-Za-z0-9-]+)['"`]\s+header\s+(?:is\s+)?(?:missing|required)/i,
    /\b([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\s+header\s+(?:is\s+)?(?:missing|required)/i,
  ];
  for (const re of patterns) {
    const name = said.match(re)?.[1];
    if (name && !/^(is|was|the|a|an|required|missing|value)$/i.test(name)) return name;
  }
  return undefined;
}

function network(said: string): Omit<TestExplanation, "code" | "tone" | "providerSaid" | "latencyMs"> {
  if (has(said, /ENOTFOUND|EAI_AGAIN|getaddrinfo/i)) {
    return {
      meaning: "The gateway's host name could not be found, so no request was sent.",
      action: "Check the base URL for a typo. If the gateway is internal, connect to the company VPN or network first.",
    };
  }
  if (has(said, /bad port/i)) return { meaning: "Rig will not connect to that port: it is on the list of ports blocked for safety.", action: "Check the port in the base URL; gateways normally use 443 (https) or a high port." };
  if (has(said, /ECONNREFUSED/i)) return { meaning: "The host was found, but nothing accepted the connection at that address and port.", action: "Check the port and scheme (http or https) in the base URL, and that the service is running." };
  if (has(said, /SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY|CERT_|certificate/i)) {
    return {
      meaning: "The connection was refused because Rig does not trust the server's TLS certificate. A company proxy that inspects traffic usually causes this.",
      action: "Set up certificate trust as described in docs/windows-setup.md (Windows certificate trust), then restart Rig.",
    };
  }
  if (has(said, /ETIMEDOUT|timed out|timeout|UND_ERR_CONNECT_TIMEOUT/i)) return { meaning: "Nothing answered in time.", action: "Check the VPN, a proxy, or a firewall between this computer and the gateway, then test again." };
  if (has(said, /ECONNRESET|socket hang up|other side closed|UND_ERR_SOCKET/i)) return { meaning: "The connection was opened and then dropped before an answer came back, often by a proxy.", action: "Test again. If it keeps happening, check the proxy settings." };
  return { meaning: "Rig could not connect to the gateway, so no request reached it.", action: "Check the base URL and your network connection." };
}

/** Explain one model's last test. Undefined for a model that has not been tested. */
export function explainTestResult(t: TestOutcome, ctx: TestContext = {}): TestExplanation | undefined {
  if (t.status === "unprobed" || t.status === "listed") return undefined;
  const { said = "", latencyMs } = parseTestMessage(t.statusMessage);
  // Results saved before Rig recorded HTTP codes have only a status; it implies the code.
  const code = t.statusCode ?? IMPLIED_CODE[t.status];
  const base = { code: code === undefined && t.status === "entitled" ? "Answered" : httpLabel(code), providerSaid: said || undefined, latencyMs };
  const keyHeader = ctx.authHeader ?? "the key header";
  const extra = ctx.extraHeaders?.length ? ` Rig sends ${ctx.extraHeaders.join(", ")} with every request.` : "";

  if (t.status === "entitled" && (code === undefined || code < 400)) {
    return { ...base, tone: "ok", providerSaid: undefined, meaning: "The model answered a short test request. The key, route, and headers all work." };
  }

  if (code === undefined) return { ...base, tone: "bad", ...network(said) };

  // A successful answer in the other dialect's format; the runtime's message says which.
  if (code < 400) {
    return { ...base, tone: "bad", providerSaid: undefined, meaning: said || "The provider answered, but not in the format this model is set to.", action: "Edit the model and set its dialect to match the route." };
  }

  const header = missingHeader(said);
  switch (true) {
    case code === 400 || code === 422: {
      if (header) {
        const sent = ctx.extraHeaders?.some((h) => h.toLowerCase() === header.toLowerCase());
        return {
          ...base,
          tone: "warn",
          meaning: sent ? `The gateway says the ${header} header is missing or invalid, although Rig sends it.` : `The gateway requires the ${header} header, which Rig did not send.`,
          action: sent ? `Check the value of ${header} under Connection, Additional request headers.` : `Add ${header} under Connection, Additional request headers, then save and test.`,
        };
      }
      if (has(said, /temperature|top_p|top_k|sampling/i)) return { ...base, tone: "warn", meaning: "The model does not accept sampling settings such as temperature.", action: "Clear Temperature on agents that use this model." };
      if (has(said, /thinking|reasoning|effort/i)) return { ...base, tone: "warn", meaning: "The model rejects the reasoning setting it was sent.", action: "Turn reasoning off for this model in its Edit form, or clear the agent's reasoning effort." };
      if (has(said, /max_completion_tokens|max_tokens/i)) {
        return { ...base, tone: "warn", meaning: "The provider rejects the field Rig uses for the output limit.", action: "Edit the model and switch its max tokens field between max_tokens and max_completion_tokens." };
      }
      if (has(said, /api[-_ ]?version/i)) return { ...base, tone: "warn", meaning: "The gateway wants a different API version.", action: "Edit the model and set the api-version query parameter your gateway documents." };
      if (has(said, /DeploymentNotFound|deployment[^.]*(not found|does not exist)|model[^.]*(not found|does not exist|invalid|unknown)/i)) {
        return { ...base, tone: "bad", meaning: "The provider does not recognise the model or deployment name in the request.", action: "Edit the model and check its id, or the model id it sends in the request body." };
      }
      if (has(said, /content[_ ]?filter|content management policy|ResponsibleAI|safety/i)) return { ...base, tone: "warn", meaning: "A content filter blocked the test request.", action: "This is unusual for a one-word test. Ask the gateway administrator about the filter policy." };
      return {
        ...base,
        tone: "warn",
        meaning: "The request reached the model's endpoint, but the provider rejected what was in it. Something in the request does not match what this gateway expects.",
        action: `Read what the provider said below. Common causes are a missing required header, a wrong API version, or the wrong dialect.${extra}`,
      };
    }
    case code === 401:
      if (has(said, /missing or invalid|invalid or missing/i)) {
        return {
          ...base,
          tone: "bad",
          meaning: `The gateway did not accept a key: either it is not where the gateway looks, or it is wrong. Rig sends the key in ${keyHeader}.`,
          action: "Under Connection, check Header for the key (Azure API Management uses Ocp-Apim-Subscription-Key) and paste the current key.",
        };
      }
      if (has(said, /missing|not provided|no subscription key|without/i)) {
        return { ...base, tone: "bad", meaning: `The gateway did not find a key where it looks for one. Rig sends the key in ${keyHeader}.`, action: "Under Connection, set Header for the key to what the gateway expects (Azure API Management uses Ocp-Apim-Subscription-Key)." };
      }
      return { ...base, tone: "bad", meaning: `The gateway rejected the key sent in ${keyHeader}: it is wrong, expired, or meant for a different gateway or product.`, action: "Paste the current key under Connection. If the key is right, check Header for the key and Text before the key." };
    case code === 402:
      return { ...base, tone: "bad", meaning: "The account behind this key has no credit or billing set up.", action: "Check billing with the provider or the gateway administrator." };
    case code === 403:
      if (has(said, /firewall in front of the provider blocked/i)) {
        return {
          ...base,
          tone: "bad",
          meaning: "A firewall in front of the gateway blocked the request before it reached the model. Firewalls like this inspect what a request contains, so a short test can pass while a chat (which also sends the agent's instructions, tools, and conversation) is blocked.",
          action: "Give the reference to whoever runs the gateway and ask which firewall rule matched and why.",
        };
      }
      if (has(said, /\b(ip|ip address|network|firewall|location|region|country)\b/i)) return { ...base, tone: "bad", meaning: "The gateway refused the request because of where it came from (network, IP address, or region).", action: "Connect to the network the gateway allows, such as the company VPN." };
      return { ...base, tone: "bad", meaning: "The key is valid, but it is not allowed to use this model or route.", action: "Ask the gateway administrator to grant your subscription access to this model, or pick a model you have access to." };
    case code === 404:
      if (has(said, /model|deployment/i)) return { ...base, tone: "bad", meaning: "The provider does not have a model or deployment with this name.", action: "Edit the model and check its id against what the gateway lists." };
      return {
        ...base,
        tone: "bad",
        meaning: `Nothing was found at the address Rig called${ctx.url ? ` (${ctx.url})` : ""}.`,
        action: "Check the base URL under Connection (a missing or extra path segment is common) and the model's route.",
      };
    case code === 405:
      return { ...base, tone: "bad", meaning: "That address exists, but does not accept this kind of request.", action: "The route is probably wrong: edit the model and check its route." };
    case code === 408 || code === 504:
      return { ...base, tone: "bad", meaning: "The gateway gave up waiting for the model to answer.", action: "Test again. If it keeps happening, the model backend may be overloaded or unreachable from the gateway." };
    case code === 413:
      return { ...base, tone: "bad", meaning: "The gateway says the request is too large.", action: "Ask the gateway administrator about its request size limit." };
    case code === 415:
      return { ...base, tone: "bad", meaning: "The gateway does not accept the request's content type.", action: "Check that the model's dialect matches what the gateway expects." };
    case code === 429:
      if (has(said, /quota|budget|exceeded|limit reached|insufficient/i)) return { ...base, tone: "warn", meaning: "The quota or budget for this key or model is used up.", action: "Wait for the quota to reset, or ask the gateway administrator for more." };
      return { ...base, tone: "warn", meaning: "Too many requests: the provider asked Rig to slow down.", action: "Wait a minute and test again." };
    case code === 502:
      return { ...base, tone: "bad", meaning: "The gateway is up, but could not reach the model service behind it.", action: "Usually temporary. Test again, and tell the gateway administrator if it persists." };
    case code === 503 || code === 529:
      return { ...base, tone: "bad", meaning: has(said, /overload/i) ? "The model is overloaded right now." : "The model service is temporarily unavailable.", action: "Test again in a minute." };
    case code >= 500:
      return { ...base, tone: "bad", meaning: "The provider had an internal error. This is not caused by your settings.", action: "Test again. If it persists, tell the gateway administrator." };
    default:
      return { ...base, tone: "bad", meaning: "The provider answered with an error.", action: "Read what the provider said below." };
  }
}
