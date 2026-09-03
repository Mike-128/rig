// Connections, gateway profiles, and models.
// Auth lives on the Connection. Dialect and route live on the Model.

export type Dialect = "anthropic.messages" | "openai.chat";

export interface Capabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

/** USD per 1M tokens. */
export interface Pricing {
  input: number;
  output: number;
  cachedInput?: number;
  /** Where the numbers came from; "estimate" means editable and not authoritative. */
  source?: "vendor" | "estimate";
}

export interface ModelParams {
  /** OpenAI-dialect servers differ on the max-tokens field name. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Send stream_options.include_usage on OpenAI-dialect streams. Default true. */
  streamUsage?: boolean;
}

export interface AuthSpec {
  headerName: string;
  /** Prepended to the secret, e.g. "Bearer ". */
  prefix?: string;
}

export interface ProfileModelEntry {
  /** Harness-facing id, unique within the profile. */
  id: string;
  displayName?: string;
  dialect: Dialect;
  /** Path appended to the connection base URL. */
  route: string;
  query?: Record<string, string>;
  /** Value sent in the request body's model field. Defaults to id. */
  bodyModel?: string;
  capabilities?: Partial<Capabilities>;
  pricing?: Pricing;
  params?: ModelParams;
}

export interface ListModelsSpec {
  dialect: Dialect;
  route: string;
  /** Regex source; only listed ids matching are kept. */
  filter?: string;
  /** Route used for models discovered by listing but absent from the catalog. */
  defaultRoute: string;
  defaultQuery?: Record<string, string>;
  defaultParams?: ModelParams;
  /** Strip this prefix from listed ids (Gemini returns "models/..."). */
  stripPrefix?: string;
}

export interface GatewayProfile {
  id: string;
  displayName: string;
  description?: string;
  baseUrl: string;
  auth: AuthSpec;
  extraHeaders?: Record<string, string>;
  models: ProfileModelEntry[];
  listModels?: ListModelsSpec;
  /** Marks a template the user must edit (APIM). */
  template?: boolean;
}

export type ConnectionKind = "direct" | "gateway" | "local";

export interface Connection {
  id: string;
  name: string;
  profileId: string;
  kind: ConnectionKind;
  baseUrl: string;
  auth: AuthSpec;
  extraHeaders?: Record<string, string>;
  secretLast4: string;
  createdAt: string;
}

export type EntitlementStatus =
  | "entitled"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "unknown"
  | "listed"
  | "unprobed";

export interface Model {
  id: string; // `${connectionId}/${providerModelId}`
  connectionId: string;
  providerModelId: string;
  bodyModel: string;
  displayName: string;
  dialect: Dialect;
  route: string;
  query?: Record<string, string>;
  capabilities: Capabilities;
  pricing?: Pricing;
  params?: ModelParams;
  status: EntitlementStatus;
  statusMessage?: string;
  lastProbedAt?: string;
  origin: "catalog" | "listed" | "manual";
}

export interface ModelAlias {
  alias: string;
  connectionId: string;
  modelId: string; // providerModelId
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  streaming: true,
  tools: true,
  vision: false,
  reasoning: false,
};
