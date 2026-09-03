import { serve, type ServerType } from "@hono/node-server";
import type { RuntimeConfig } from "./config";
import { buildApp, type BuiltApp } from "./app";

export interface RunningServer extends BuiltApp {
  server: ServerType;
  port: number;
  close(): Promise<void>;
}

/** Build the app and listen. With port 0 the OS picks a port and the proxy origin is updated to match. */
export async function startServer(overrides: Partial<RuntimeConfig> = {}, opts: { fileSecrets?: boolean } = {}): Promise<RunningServer> {
  const built = await buildApp(overrides, opts);
  const { app, hono } = built;
  let server!: ServerType;
  const port = await new Promise<number>((resolve, reject) => {
    const s = serve({ fetch: hono.fetch, hostname: app.config.host, port: app.config.port }, (info) => resolve(info.port));
    s.once("error", reject);
    server = s;
  });
  app.config.port = port;
  app.config.proxyOrigin = `http://${app.config.host}:${port}`;
  return {
    ...built,
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        app.db.close();
      }),
  };
}
