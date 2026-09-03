import type { GatewayProfile, ProfileModelEntry } from "../types/model";

// Pricing is USD per 1M tokens. Anthropic figures come from the vendor table;
// OpenAI and Google figures are estimates and editable in the catalog.

const anthropic = (
  id: string,
  displayName: string,
  pricing: { input: number; output: number; cachedInput?: number },
  ctx = 1_000_000,
): ProfileModelEntry => ({
  id,
  displayName,
  dialect: "anthropic.messages",
  route: "/v1/messages",
  capabilities: { streaming: true, tools: true, vision: true, reasoning: true, maxContextTokens: ctx, maxOutputTokens: 128_000 },
  pricing: { ...pricing, source: "vendor" },
});

const openai = (
  id: string,
  displayName: string,
  pricing: { input: number; output: number; cachedInput?: number },
  opts: { reasoning?: boolean; ctx?: number } = {},
): ProfileModelEntry => ({
  id,
  displayName,
  dialect: "openai.chat",
  route: "/v1/chat/completions",
  capabilities: { streaming: true, tools: true, vision: true, reasoning: opts.reasoning ?? false, maxContextTokens: opts.ctx ?? 400_000 },
  pricing: { ...pricing, source: "estimate" },
  params: { maxTokensField: "max_completion_tokens" },
});

const gemini = (
  id: string,
  displayName: string,
  pricing: { input: number; output: number },
  opts: { reasoning?: boolean; ctx?: number } = {},
): ProfileModelEntry => ({
  id,
  displayName,
  dialect: "openai.chat",
  route: "/v1beta/openai/chat/completions",
  bodyModel: id,
  capabilities: { streaming: true, tools: true, vision: true, reasoning: opts.reasoning ?? true, maxContextTokens: opts.ctx ?? 1_000_000 },
  pricing: { ...pricing, source: "estimate" },
  params: { maxTokensField: "max_tokens" },
});

export const BUILTIN_PROFILES: GatewayProfile[] = [
  {
    id: "anthropic-direct",
    displayName: "Anthropic (direct)",
    description: "api.anthropic.com with an Anthropic API key.",
    baseUrl: "https://api.anthropic.com",
    auth: { headerName: "x-api-key" },
    models: [
      anthropic("claude-opus-5", "Claude Opus 5", { input: 5, output: 25, cachedInput: 0.5 }),
      anthropic("claude-sonnet-5", "Claude Sonnet 5", { input: 2, output: 10, cachedInput: 0.2 }),
      anthropic("claude-opus-4-8", "Claude Opus 4.8", { input: 5, output: 25, cachedInput: 0.5 }),
      anthropic("claude-sonnet-4-6", "Claude Sonnet 4.6", { input: 3, output: 15, cachedInput: 0.3 }),
      anthropic("claude-haiku-4-5", "Claude Haiku 4.5", { input: 1, output: 5, cachedInput: 0.1 }, 200_000),
    ],
    listModels: {
      dialect: "anthropic.messages",
      route: "/v1/models",
      filter: "^claude-",
      defaultRoute: "/v1/messages",
    },
  },
  {
    id: "openai-direct",
    displayName: "OpenAI (direct)",
    description: "api.openai.com with an OpenAI API key. Chat Completions dialect.",
    baseUrl: "https://api.openai.com",
    auth: { headerName: "Authorization", prefix: "Bearer " },
    models: [
      openai("gpt-5", "GPT-5", { input: 1.25, output: 10, cachedInput: 0.125 }, { reasoning: true }),
      openai("gpt-5-mini", "GPT-5 mini", { input: 0.25, output: 2, cachedInput: 0.025 }, { reasoning: true }),
      openai("gpt-5-nano", "GPT-5 nano", { input: 0.05, output: 0.4, cachedInput: 0.005 }, { reasoning: true }),
      openai("gpt-4.1", "GPT-4.1", { input: 2, output: 8, cachedInput: 0.5 }, { ctx: 1_000_000 }),
      openai("gpt-4.1-mini", "GPT-4.1 mini", { input: 0.4, output: 1.6, cachedInput: 0.1 }, { ctx: 1_000_000 }),
    ],
    listModels: {
      dialect: "openai.chat",
      route: "/v1/models",
      filter: "^(gpt-|o[0-9])",
      defaultRoute: "/v1/chat/completions",
      defaultParams: { maxTokensField: "max_completion_tokens" },
    },
  },
  {
    id: "google-gemini",
    displayName: "Google Gemini (OpenAI-compatible)",
    description: "generativelanguage.googleapis.com via Google's OpenAI-compatible endpoint, with a Google AI API key.",
    baseUrl: "https://generativelanguage.googleapis.com",
    auth: { headerName: "Authorization", prefix: "Bearer " },
    models: [
      gemini("gemini-2.5-pro", "Gemini 2.5 Pro", { input: 1.25, output: 10 }),
      gemini("gemini-2.5-flash", "Gemini 2.5 Flash", { input: 0.3, output: 2.5 }),
      gemini("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", { input: 0.1, output: 0.4 }),
      gemini("gemini-3-pro-preview", "Gemini 3 Pro (preview)", { input: 2, output: 12 }),
      gemini("gemini-3-flash-preview", "Gemini 3 Flash (preview)", { input: 0.5, output: 3 }),
    ],
    listModels: {
      dialect: "openai.chat",
      route: "/v1beta/openai/models",
      filter: "^gemini-",
      defaultRoute: "/v1beta/openai/chat/completions",
      defaultParams: { maxTokensField: "max_tokens" },
      stripPrefix: "models/",
    },
  },
  {
    id: "openai-compatible",
    displayName: "OpenAI-compatible server (custom)",
    description: "Any server that speaks Chat Completions (Ollama, vLLM, LM Studio, LiteLLM). Edit the base URL; add models manually or list them.",
    baseUrl: "http://localhost:11434",
    auth: { headerName: "Authorization", prefix: "Bearer " },
    models: [],
    listModels: {
      dialect: "openai.chat",
      route: "/v1/models",
      defaultRoute: "/v1/chat/completions",
      defaultParams: { maxTokensField: "max_tokens" },
    },
    template: true,
  },
  {
    id: "apim-gateway",
    displayName: "Azure API Management gateway (template)",
    description: "A virtual key that fronts several providers. Edit the base URL, header name, and routes to match your gateway.",
    baseUrl: "https://your-gateway.azure-api.net",
    auth: { headerName: "Ocp-Apim-Subscription-Key" },
    models: [
      {
        id: "claude-opus-5",
        displayName: "Claude Opus 5 via gateway",
        dialect: "anthropic.messages",
        route: "/anthropic/v1/messages",
        capabilities: { streaming: true, tools: true, vision: true, reasoning: true },
      },
      {
        id: "gpt-5",
        displayName: "GPT-5 via gateway",
        dialect: "openai.chat",
        route: "/openai/deployments/gpt-5/chat/completions",
        query: { "api-version": "2025-04-01-preview" },
        capabilities: { streaming: true, tools: true, vision: true, reasoning: true },
        params: { maxTokensField: "max_completion_tokens" },
      },
    ],
    template: true,
  },
];

export function findProfile(id: string, extra: GatewayProfile[] = []): GatewayProfile | undefined {
  return [...BUILTIN_PROFILES, ...extra].find((p) => p.id === id);
}
