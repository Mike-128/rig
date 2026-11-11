import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRuntime, runDoctor, supportedNode, type DoctorOptions } from "../src/doctor";

const options: DoctorOptions = { workspace: process.cwd(), timeoutMs: 100, baseUrl: "http://127.0.0.1:7777" };
const health = { ok: true, secrets: "os-keychain", home: "private-location", version: "0.2.0" };
const model = { connectionId: "conn/a", providerModelId: "model/b", status: "entitled" };
const alias = { alias: "default", connectionId: model.connectionId, modelId: model.providerModelId };
function mockApi(probeStatus = "entitled") {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const data = url.endsWith("/health") ? health : url.endsWith("/models") ? [model] : url.endsWith("/aliases") ? [alias] : { status: probeStatus };
    return Response.json(data);
  });
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("doctor", () => {
  it("exposes parseable JSON and rejects contradictory CLI flags", async () => {
    const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const directory = await mkdtemp(path.join(os.tmpdir(), "rig-doctor-cli-"));
    const execute = promisify(execFile);
    try {
      const { stdout } = await execute(process.execPath, ["--import", "tsx", cli, "doctor", "--offline", "--json", "--workspace", directory], {
        env: { ...process.env, RIG_HOME: directory, NODE_EXTRA_CA_CERTS: "", NODE_TLS_REJECT_UNAUTHORIZED: "1" }, timeout: 15_000,
      });
      expect(JSON.parse(stdout).exitCode).toBe(0);
      await expect(execute(process.execPath, ["--import", "tsx", cli, "doctor", "--offline", "--probe"], { timeout: 5000 }))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("cannot be combined") });
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  it("checks the minimum Node minor version", () => {
    expect(supportedNode("22.12.0")).toBe(false);
    expect(supportedNode("22.13.0")).toBe(true);
    expect(supportedNode("24.0.0")).toBe(true);
    expect(supportedNode("20.19.0")).toBe(false);
  });

  it("only reads health and catalog by default, without exposing private values", async () => {
    const fetcher = mockApi();
    const report = await checkRuntime(options, fetcher);
    expect(report.every((check) => check.status === "pass")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(health.home);
  });

  it("probes exactly the default model only when requested", async () => {
    const fetcher = mockApi();
    const report = await checkRuntime({ ...options, probe: true }, fetcher);
    expect(fetcher.mock.calls[3][0]).toBe("http://127.0.0.1:7777/api/models/conn%2Fa/model%2Fb/probe");
    expect(fetcher.mock.calls[3][1]?.method).toBe("POST");
    expect(report.at(-1)?.status).toBe("pass");
    expect(report.at(-1)?.message).toContain("streaming and tool execution are not verified");
  });

  it("reports denied entitlement as failure", async () => {
    const report = await checkRuntime({ ...options, probe: true }, mockApi("forbidden"));
    expect(report.at(-1)?.status).toBe("fail");
  });

  it("does not probe when the default alias is absent", async () => {
    const fetcher = mockApi();
    fetcher.mockImplementation(async (input) => Response.json(String(input).endsWith("/health") ? health : []));
    expect((await checkRuntime({ ...options, probe: true }, fetcher)).at(-1)?.status).toBe("fail");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects another service's health response and redacts connection errors", async () => {
    expect((await checkRuntime(options, vi.fn(async () => Response.json({ ok: true })))).at(-1)?.status).toBe("fail");
    const report = await checkRuntime(options, vi.fn(async () => { throw new Error("secret-token"); }));
    expect(report[0].status).toBe("fail");
    expect(JSON.stringify(report)).not.toContain("secret-token");
  });

  it("rejects credential-bearing runtime URLs before making requests", async () => {
    const fetcher = mockApi();
    const report = await checkRuntime({ ...options, baseUrl: "http://user:secret@localhost:7777" }, fetcher);
    expect(report[0].status).toBe("fail");
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("secret@");
  });

  it("times out even when the server sends headers but never completes its body", async () => {
    const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"ok":'); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      const report = await checkRuntime({ ...options, baseUrl: `http://127.0.0.1:${address.port}` });
      expect(report[0].status).toBe("fail");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("offline checks clean up temporary files and never call HTTP", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "rig-doctor-test-"));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("RIG_HOME", path.join(directory, "missing-home"));
    vi.stubEnv("HTTPS_PROXY", "https://user:secret@proxy.example");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "");
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "1");
    try {
      const report = await runDoctor({ ...options, offline: true, workspace: directory, timeoutMs: 5000 });
      expect(report.exitCode).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("secret@");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("fails a missing workspace without creating it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "rig-doctor-test-"));
    vi.stubEnv("RIG_HOME", directory);
    try {
      const report = await runDoctor({ ...options, offline: true, workspace: path.join(directory, "missing") });
      expect(report.exitCode).toBe(1);
      expect(report.checks.find((check) => check.id === "workspace")?.status).toBe("fail");
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
