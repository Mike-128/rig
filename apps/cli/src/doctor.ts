import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export interface Check {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
}
export interface DoctorOptions {
  offline?: boolean;
  probe?: boolean;
  workspace: string;
  timeoutMs: number;
  baseUrl: string;
}
export interface DoctorReport {
  version: 1;
  checks: Check[];
  exitCode: number;
}

export function supportedNode(version: string): boolean {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

// Do not copy exception messages into reports: URLs and provider errors may contain credentials.
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code && /^[A-Z_0-9]+$/.test(code) ? code : "unavailable";
}

async function checkWritable(target: string, allowMissing: boolean): Promise<string> {
  let directory = path.resolve(target);
  let missing = false;
  while (true) {
    try {
      await access(directory, constants.F_OK);
      break;
    } catch (error) {
      if (!allowMissing || errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
      missing = true;
    }
  }
  const scratch = await mkdtemp(path.join(directory, ".rig-doctor-"));
  const file = path.join(scratch, "write-test");
  try {
    await writeFile(file, "rig doctor", { flag: "wx" });
    if (await readFile(file, "utf8") !== "rig doctor") throw new Error("readback failed");
  } finally {
    await unlink(file).catch((error) => { if (errorCode(error) !== "ENOENT") throw error; });
    await rmdir(scratch);
  }
  return missing ? "Not created yet; nearest existing parent allows temporary writes." : "Temporary create/read/delete succeeded.";
}

type RuntimeHealth = { ok: true; secrets: string; home: string; version: string };
function isHealth(value: unknown): value is RuntimeHealth {
  const h = value as Partial<RuntimeHealth> | null;
  return !!h && h.ok === true && typeof h.secrets === "string" && typeof h.home === "string" && typeof h.version === "string";
}

export async function checkRuntime(options: DoctorOptions, fetcher: typeof fetch = fetch): Promise<Check[]> {
  const checks: Check[] = [];
  let base: URL;
  try {
    base = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
  } catch {
    return [{ id: "runtime", status: "fail", message: "RIG_URL must be an HTTP(S) URL without credentials, query, or fragment." }];
  }
  const request = async (endpoint: string, method = "GET", timeoutMs = options.timeoutMs): Promise<unknown> => {
    const response = await fetcher(`${base.href.replace(/\/+$/, "")}/api${endpoint}`, {
      method, signal: AbortSignal.timeout(timeoutMs), redirect: "error",
    });
    if (!response.ok) throw new Error("runtime request failed");
    return response.json();
  };
  try {
    const health = await request("/health");
    if (!isHealth(health)) throw new Error("not Rig health");
    checks.push({ id: "runtime", status: "pass", message: "Rig health endpoint responded. This does not verify provider connectivity." });
    checks.push({ id: "credentials", status: health.secrets === "os-keychain" ? "pass" : "warn",
      message: health.secrets === "os-keychain" ? "Runtime reports OS keychain storage." : "Runtime does not report OS keychain storage. Review credential storage before adding work keys." });
  } catch {
    return [{ id: "runtime", status: "fail", message: "Runtime health check failed or timed out. Start rig serve; check RIG_URL, port conflicts, and local network policy." }];
  }
  try {
    const models = await request("/models");
    const aliases = await request("/aliases");
    if (!Array.isArray(models) || !Array.isArray(aliases)) throw new Error();
    const binding = aliases.find((a) => a?.alias === "default");
    const model = binding && models.find((m) => m?.connectionId === binding.connectionId && m?.providerModelId === binding.modelId);
    if (!model || typeof model.connectionId !== "string" || typeof model.providerModelId !== "string") {
      checks.push({ id: "default-model", status: options.probe ? "fail" : "warn", message: "No valid default model alias. Add a connection and bind default in Models." });
    } else {
      checks.push({ id: "default-model", status: "pass", message: "Default alias resolves to a registered model. Saved entitlement is not a live connectivity test." });
      if (options.probe) {
        // The existing runtime probe owns credentials and uses a 30-second SDK deadline.
        const result = await request(`/models/${encodeURIComponent(model.connectionId)}/${encodeURIComponent(model.providerModelId)}/probe`, "POST", Math.max(options.timeoutMs, 35_000)) as { status?: string };
        checks.push({ id: "provider-probe", status: result?.status === "entitled" ? "pass" : "fail", message: result?.status === "entitled"
          ? "Default model probe reached the provider. Entitlement includes validation responses; streaming and tool execution are not verified."
          : "Default model probe did not establish entitlement. Inspect Models for details; check gateway access, authentication, and quota." });
      }
    }
  } catch {
    checks.push({ id: "model-access", status: "fail", message: "Catalog or requested provider probe failed or timed out. Check runtime logs and model configuration." });
  }
  return checks;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (id: string, status: Check["status"], message: string) => checks.push({ id, status, message });
  add("node", supportedNode(process.versions.node) ? "pass" : "fail", `Node ${process.versions.node}; Rig requires 22.13 or newer.`);
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try { db.exec("CREATE TABLE doctor (value INTEGER); INSERT INTO doctor VALUES (1)"); }
    finally { db.close(); }
    add("sqlite", "pass", "Built-in SQLite opened and wrote an in-memory database.");
  } catch { add("sqlite", "fail", "Built-in SQLite unavailable. Use an approved Node version with node:sqlite enabled."); }

  for (const [id, directory, allowMissing] of [
    ["data-directory", process.env.RIG_HOME ?? path.join(os.homedir(), ".rig"), true],
    ["workspace", options.workspace, false],
  ] as const) {
    try { add(id, "pass", await checkWritable(directory, allowMissing)); }
    catch (error) { add(id, "fail", `Temporary write check failed (${errorCode(error)}). Select an existing writable workspace or set RIG_HOME to an approved writable location.`); }
  }
  try {
    const windows = process.platform === "win32";
    const { stdout } = await promisify(execFile)(windows ? "powershell.exe" : "bash",
      windows ? ["-NoProfile", "-NonInteractive", "-Command", "Write-Output rig-doctor-ok"] : ["-lc", "printf rig-doctor-ok"],
      { cwd: path.resolve(options.workspace), timeout: options.timeoutMs, windowsHide: true, maxBuffer: 4096 });
    if (stdout.trim() !== "rig-doctor-ok") throw new Error();
    add("shell", "pass", "Rig's shell executed a harmless command with the current user's permissions.");
  } catch { add("shell", "warn", "Rig's shell failed or timed out. Check shell availability and process policy; read-only agents can still work."); }

  const proxySet = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some((key) => !!process.env[key]);
  add("proxy", proxySet ? "warn" : "pass", proxySet
    ? "Proxy environment variables are present (values hidden). Verify runtime proxy support and a loopback NO_PROXY exemption. Presence alone does not prove routing works."
    : "No proxy environment variables detected in this CLI process; company proxy requirements remain unverified.");
  if (process.env.NODE_EXTRA_CA_CERTS) {
    try { await access(process.env.NODE_EXTRA_CA_CERTS, constants.R_OK); add("certificates", "pass", "Additional CA file is readable; certificate validity and runtime TLS trust remain unverified."); }
    catch { add("certificates", "fail", "NODE_EXTRA_CA_CERTS points to an unreadable file. Use the approved company CA file."); }
  } else add("certificates", "warn", "No additional CA file configured in this CLI process. If company TLS inspection is used, verify the runtime trust configuration.");
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") add("tls-verification", "fail", "TLS verification is disabled in this process. Restore verification and configure approved trust certificates.");
  if (options.offline) add("runtime", "warn", "Offline mode: runtime, credential backend, catalog, and providers were not checked.");
  else checks.push(...await checkRuntime(options));
  return { version: 1, checks, exitCode: checks.some((check) => check.status === "fail") ? 1 : 0 };
}
