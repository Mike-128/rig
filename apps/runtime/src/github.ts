import { spawnSync } from "node:child_process";
import type { SecretStore } from "./secrets";

/**
 * GitHub as the signed-in user, over the REST API only: no git binary, no local clone, no merge
 * state. Works with GitHub Enterprise Managed Users, which sign in on github.com (EMU usernames
 * carry a _shortcode suffix) or on a data-residency host such as acme.ghe.com, and with GitHub
 * Enterprise Server.
 */

/** API base for a GitHub host: github.com, <name>.ghe.com (data residency), or a GHES hostname. */
export function apiBase(host: string): string {
  const h = host.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
  if (h === "github.com" || h === "www.github.com") return "https://api.github.com";
  if (h.endsWith(".ghe.com")) return `https://api.${h}`;
  return `https://${h}/api/v3`;
}

export function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase() || "github.com";
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export interface GitHubUser {
  login: string;
  name: string | null;
  email: string | null;
  id: number;
}

type Json = Record<string, any>;

export class GitHubClient {
  readonly base: string;

  constructor(
    readonly host: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
    base?: string,
  ) {
    this.base = base ?? apiBase(host);
  }

  async request<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "rig",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as Json) : {};
    if (!res.ok) throw new GitHubError(explain(res.status, String(data.message ?? res.statusText), path), res.status);
    return data as T;
  }

  user(): Promise<GitHubUser> {
    return this.request("GET", "/user");
  }
}

/** GitHub's messages assume a browser; say what to do in Rig's terms. */
function explain(status: number, message: string, path: string): string {
  if (status === 401) return "GitHub rejected the sign-in (401). Sign in again on the Team page.";
  if (status === 403 && /rate limit/i.test(message)) return "GitHub rate limit reached; try again in a few minutes.";
  if (status === 403 && /SAML|SSO|enterprise/i.test(message)) return `GitHub refused: ${message}. Your enterprise may need to approve this sign-in method for the organization.`;
  if (status === 403) return `GitHub refused ${path}: ${message}. Your account may lack write access to the repository.`;
  if (status === 404) return `Not found on GitHub: ${path}. Check the owner and repository name, and that your account can see it.`;
  return `GitHub ${status} on ${path}: ${message}`;
}

// ---------- signing in ----------

export interface GitHubConnection {
  host: string;
  login: string;
  name: string | null;
  email: string | null;
  method: "gh-cli" | "token" | "device";
}

const secretId = (host: string) => `github:${normalizeHost(host)}`;

/**
 * The user's GitHub sign-in, one host at a time. The token lives in the OS keychain like model keys
 * and never leaves the runtime: the browser sees only the login.
 */
export class GitHubAuth {
  private connection: GitHubConnection | undefined;
  private device: { host: string; clientId: string; deviceCode: string; interval: number; expires: number } | undefined;

  constructor(
    private secrets: SecretStore,
    private statePath: () => GitHubConnection | undefined,
    private saveState: (c: GitHubConnection | undefined) => void,
    private fetchImpl: typeof fetch = fetch,
    /** Tests point the API at a mock. */
    private baseOverride?: string,
  ) {
    this.connection = statePath();
  }

  status(): GitHubConnection | undefined {
    return this.connection;
  }

  async client(): Promise<GitHubClient> {
    if (!this.connection) throw new GitHubError("Not signed in to GitHub. Sign in on the Team page.", 401);
    const token = await this.secrets.get(secretId(this.connection.host));
    if (!token) throw new GitHubError("The GitHub sign-in is missing from the keychain. Sign in again on the Team page.", 401);
    return new GitHubClient(this.connection.host, token, this.fetchImpl, this.baseOverride);
  }

  /** Validates a token by asking GitHub who it belongs to, then stores it. */
  async connectWithToken(host: string, token: string, method: GitHubConnection["method"] = "token"): Promise<GitHubConnection> {
    const h = normalizeHost(host);
    const user = await new GitHubClient(h, token.trim(), this.fetchImpl, this.baseOverride).user();
    await this.secrets.set(secretId(h), token.trim());
    this.connection = { host: h, login: user.login, name: user.name, email: user.email, method };
    this.saveState(this.connection);
    return this.connection;
  }

  /**
   * Reuses the GitHub CLI's sign-in, which is how most EMU users are already authenticated
   * (gh auth login goes through the enterprise's identity provider).
   */
  async connectWithGhCli(host: string): Promise<GitHubConnection> {
    const h = normalizeHost(host);
    const r = spawnSync("gh", ["auth", "token", "--hostname", h], { encoding: "utf8", windowsHide: true });
    if (r.error) throw new GitHubError("The GitHub CLI (gh) is not installed or not on PATH. Install it, or use a token instead.", 400);
    const token = r.stdout.trim();
    if (r.status !== 0 || !token) throw new GitHubError(`gh is not signed in to ${h}. Run "gh auth login --hostname ${h}" in a terminal, then try again.`, 400);
    return this.connectWithToken(h, token, "gh-cli");
  }

  /**
   * OAuth device flow: the user enters a short code on GitHub in their browser. Needs the client ID
   * of an OAuth app the enterprise has registered or approved for this purpose.
   */
  async startDeviceFlow(host: string, clientId: string): Promise<{ userCode: string; verificationUri: string; expiresIn: number }> {
    const h = normalizeHost(host);
    const res = await this.fetchImpl(`https://${h}/login/device/code`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: clientId, scope: "repo" }),
    });
    const d = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok || !d.device_code) throw new GitHubError(`GitHub did not start the sign-in: ${d.error_description ?? d.error ?? res.status}`, 400);
    this.device = { host: h, clientId, deviceCode: d.device_code, interval: Number(d.interval ?? 5), expires: Date.now() + Number(d.expires_in ?? 900) * 1000 };
    return { userCode: d.user_code, verificationUri: d.verification_uri, expiresIn: Number(d.expires_in ?? 900) };
  }

  /** One poll of the device flow. The browser calls this every few seconds until it settles. */
  async pollDeviceFlow(): Promise<{ status: "pending" | "done" | "expired" | "denied"; connection?: GitHubConnection; retryIn?: number }> {
    const d = this.device;
    if (!d || Date.now() > d.expires) return { status: "expired" };
    const res = await this.fetchImpl(`https://${d.host}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: d.clientId, device_code: d.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const r = (await res.json().catch(() => ({}))) as Json;
    if (r.access_token) {
      this.device = undefined;
      return { status: "done", connection: await this.connectWithToken(d.host, r.access_token, "device") };
    }
    if (r.error === "authorization_pending") return { status: "pending", retryIn: d.interval };
    if (r.error === "slow_down") {
      d.interval += 5;
      return { status: "pending", retryIn: d.interval };
    }
    this.device = undefined;
    return { status: r.error === "access_denied" ? "denied" : "expired" };
  }

  async signOut(): Promise<void> {
    if (this.connection) await this.secrets.delete(secretId(this.connection.host));
    this.connection = undefined;
    this.saveState(undefined);
  }
}
