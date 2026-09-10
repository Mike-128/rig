import { z } from "zod";

const reserved = new Set(["host", "connection", "content-length", "content-type", "transfer-encoding", "upgrade", "trailer", "te", "keep-alive", "proxy-authorization", "proxy-authenticate", "authorization", "x-api-key", "api-key", "ocp-apim-subscription-key", "x-rig-proxy-token"]);
export const ExtraHeaders = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || reserved.has(lower) || seen.has(lower)) {
      ctx.addIssue({ code: "custom", message: "Header names must be unique HTTP tokens and cannot override authentication or transport headers." });
    }
    if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(value)) ctx.addIssue({ code: "custom", message: "Header values cannot contain line breaks or unsupported characters." });
    seen.add(lower);
  }
}).transform((headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])));

export const DiscoverySpec = z.object({
  responseFormat: z.enum(["provider", "azure-deployments"]).default("provider"),
  defaultParams: z.object({ maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]), streamUsage: z.boolean().optional() }).optional(),
  dialect: z.enum(["openai.chat", "anthropic.messages"]),
  route: z.string().trim().min(1).startsWith("/"),
  defaultRoute: z.string().trim().min(1).startsWith("/"),
}).strict().refine((spec) => spec.responseFormat !== "azure-deployments" || spec.dialect === "openai.chat", { message: "Azure deployment listing requires OpenAI-compatible inference." });
