import type { ToolSpec } from "../types";

const MAX_CHARS = 30_000;
const BLOCKED_HOSTS = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export const webFetchTool: ToolSpec = {
  definition: {
    name: "web_fetch",
    description: "Fetch a public http(s) URL and return its text content (HTML is reduced to text). Truncated for long pages.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http or https URL." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  sideEffect: false,
  minSandbox: 0,
  async run(input, ctx) {
    const { url } = (input ?? {}) as { url?: string };
    if (typeof url !== "string") return { output: "url is required", isError: true };
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { output: `Invalid URL: ${url}`, isError: true };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { output: "Only http and https URLs are allowed", isError: true };
    if (BLOCKED_HOSTS.test(u.hostname)) return { output: "Local and private addresses are not allowed", isError: true };
    const timeout = AbortSignal.timeout(30_000);
    const signal = AbortSignal.any([timeout, ctx.signal]);
    try {
      const res = await fetch(u, { redirect: "follow", signal, headers: { "user-agent": "rig-web-fetch/0.1" } });
      const ct = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      const text = /html/i.test(ct) ? htmlToText(raw) : raw;
      const body = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + `\n\n[truncated: ${text.length - MAX_CHARS} more characters]` : text;
      return { output: `HTTP ${res.status} ${ct}\n\n${body}`, isError: !res.ok };
    } catch (e) {
      return { output: `Fetch failed: ${(e as Error).message}`, isError: true };
    }
  },
};
