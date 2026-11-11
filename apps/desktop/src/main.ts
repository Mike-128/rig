import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, session, shell, Tray } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { iconPng } from "./icon.js";

/**
 * Rig's desktop shell. It owns no agent logic: it starts (or finds) the local runtime, shows the web
 * UI in a window, and adds what a browser tab cannot: a tray icon, a global hotkey, native folder
 * picking, and notifications when an agent needs approval or finishes.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.resolve(here, "../../runtime");
const preload = path.resolve(here, "../src/preload.cjs");
const port = Number(process.env.RIG_PORT ?? 7777);
const runtimeUrl = process.env.RIG_URL ?? `http://127.0.0.1:${port}`;
/** Point the window at the Vite dev server instead, for UI work with hot reload. */
const uiUrl = process.env.RIG_DESKTOP_URL ?? runtimeUrl;
const hotkey = process.env.RIG_HOTKEY ?? "CommandOrControl+Shift+Space";
const stateFile = () => path.join(app.getPath("userData"), "window.json");
/** Smoke test: load the UI, save a screenshot of the window here, and exit (non-zero if it never loaded). */
const smokeShot = process.env.RIG_DESKTOP_SMOKE;

/**
 * The UI renders model output, which can quote hostile web pages; a strict policy means injected
 * markup cannot run script or reach other origins. Not applied to the Vite dev server, whose hot
 * reload needs inline scripts.
 */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtime: ChildProcess | null = null;
let quitting = false;
/** Approvals waiting, by run and call, so the badge clears when they are answered anywhere. */
const waiting = new Map<string, { sessionId: string; title?: string; tool: string }>();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => show());
  app.whenReady().then(main);
}

async function main(): Promise<void> {
  app.setAppUserModelId("dev.rig.desktop");
  Menu.setApplicationMenu(null);
  if (uiUrl === runtimeUrl) {
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${runtimeUrl}/*`] }, (details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } });
    });
  }
  try {
    await ensureRuntime();
  } catch (e) {
    dialog.showErrorBox("Rig could not start", `${(e as Error).message}\n\nStart it by hand with "pnpm start" in the Rig folder, then open Rig again.`);
    app.quit();
    return;
  }
  createWindow();
  createTray();
  if (!globalShortcut.register(hotkey, toggle)) console.warn(`[rig] could not register the ${hotkey} hotkey; another app may own it`);
  void watchAttention();

  ipcMain.handle("rig:pickFolder", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], title: "Open a project folder" });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("rig:openPath", async (_e, p: string) => {
    // Only folders and files that exist; never URLs or commands.
    if (typeof p === "string" && path.isAbsolute(p) && existsSync(p)) await shell.openPath(p);
  });
}

// ---------- runtime ----------

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${runtimeUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok && Boolean(((await r.json()) as { ok?: boolean }).ok);
  } catch {
    return false;
  }
}

/** Reuse a runtime that is already up (started by hand or by another tool); otherwise start one and own it. */
async function ensureRuntime(): Promise<void> {
  if (await healthy()) return;
  if (process.env.RIG_URL) throw new Error(`No Rig runtime answered at ${runtimeUrl}.`);
  const node = process.env.RIG_NODE ?? "node";
  runtime = spawn(node, ["--import", "tsx", "src/index.ts"], {
    cwd: runtimeDir,
    env: { ...process.env, RIG_PORT: String(port) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  runtime.stdout?.on("data", (d) => (log = (log + d).slice(-4000)));
  runtime.stderr?.on("data", (d) => (log = (log + d).slice(-4000)));
  const exited = new Promise<never>((_, reject) =>
    runtime!.once("exit", (code) => reject(new Error(`The runtime exited (code ${code}).\n\n${log.trim().slice(-1500)}`))),
  );
  runtime.once("error", (e) => (log += `\n${e.message} (is Node.js 22.13 or newer on PATH? Set RIG_NODE to its path otherwise)`));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const up = await Promise.race([healthy(), exited]);
    if (up) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`The runtime did not come up within 30 seconds.\n\n${log.trim().slice(-1500)}`);
}

function stopRuntime(): void {
  if (!runtime?.pid || runtime.exitCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(runtime.pid), "/T", "/F"], { windowsHide: true });
  else runtime.kill("SIGTERM");
}

// ---------- window ----------

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

function loadState(): WindowState {
  try {
    const s = JSON.parse(readFileSync(stateFile(), "utf8")) as WindowState;
    // Ignore a saved position on a monitor that is no longer attached.
    const visible = s.x !== undefined && s.y !== undefined && screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x! >= b.x - 50 && s.y! >= b.y - 50 && s.x! < b.x + b.width && s.y! < b.y + b.height;
    });
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch {
    return { width: 1280, height: 860 };
  }
}

function saveState(): void {
  if (!win) return;
  const b = win.getNormalBounds();
  writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
}

function createWindow(): void {
  const state = loadState();
  win = new BrowserWindow({
    ...state,
    minWidth: 720,
    minHeight: 480,
    title: "Rig",
    icon: nativeImage.createFromBuffer(iconPng(256)),
    backgroundColor: "#0f1115",
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => win?.show());
  void win.loadURL(uiUrl);
  if (smokeShot) {
    const fail = setTimeout(() => app.exit(1), 30_000);
    win.webContents.once("did-finish-load", () =>
      setTimeout(async () => {
        const img = await win!.webContents.capturePage();
        writeFileSync(smokeShot, img.toPNG());
        clearTimeout(fail);
        quit();
      }, 2500),
    );
  }

  // Links in agent output open in the browser; the window never navigates away from Rig.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin !== new URL(uiUrl).origin) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  const persist = debounce(saveState, 500);
  win.on("resize", persist);
  win.on("move", persist);
  win.on("focus", () => win?.flashFrame(false));
  // Closing the window keeps Rig running in the tray, so agents keep working and can still ask for approval.
  win.on("close", (e) => {
    saveState();
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
}

function show(hash?: string): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (hash) void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
}

function toggle(): void {
  if (win?.isVisible() && win.isFocused()) win.hide();
  else show();
}

// ---------- tray and attention ----------

function createTray(): void {
  tray = new Tray(nativeImage.createFromBuffer(iconPng(32)));
  tray.on("click", () => show());
  refreshTray();
}

function refreshTray(): void {
  if (!tray) return;
  const n = waiting.size;
  tray.setImage(nativeImage.createFromBuffer(iconPng(32, n > 0)));
  tray.setToolTip(n ? `Rig: ${n} approval${n === 1 ? "" : "s"} waiting` : "Rig");
  const approvals = [...waiting.values()].slice(0, 8).map((w) => ({
    label: `Approve ${w.tool} in ${w.title ?? "a session"}…`,
    click: () => show(`#/s/${w.sessionId}`),
  }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Rig", accelerator: hotkey, click: () => show() },
      { label: "New session…", click: () => show("#/s") },
      { label: "Settings", click: () => show("#/settings") },
      ...(approvals.length ? [{ type: "separator" as const }, ...approvals] : []),
      { type: "separator" },
      { label: "Open data folder", click: () => void shell.openPath(path.join(app.getPath("home"), ".rig")) },
      { label: "Quit Rig", click: () => quit() },
    ]),
  );
  if (win && process.platform === "win32") {
    win.setOverlayIcon(n ? nativeImage.createFromBuffer(iconPng(16, true)) : null, n ? `${n} waiting` : "");
  }
}

function notify(title: string, body: string, hash: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: nativeImage.createFromBuffer(iconPng(64)), silent: false });
  n.on("click", () => show(hash));
  n.show();
}

interface AttentionEvent {
  type: string;
  runId: string;
  sessionId: string;
  callId?: string;
  name?: string;
  sessionTitle?: string;
  error?: { message: string };
}

/** Follows the runtime's attention stream for the life of the app, reconnecting if it drops. */
async function watchAttention(): Promise<void> {
  while (!quitting) {
    try {
      const res = await fetch(`${runtimeUrl}/api/events`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      waiting.clear();
      while (!quitting) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (type && data) onAttention(type, JSON.parse(data));
        }
      }
    } catch {
      /* runtime restarting or briefly unreachable */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function onAttention(type: string, ev: AttentionEvent & { awaiting?: { runId: string; sessionId: string; callIds: string[] }[] }): void {
  const away = !win?.isVisible() || !win.isFocused();
  const hash = `#/s/${ev.sessionId}`;
  const title = ev.sessionTitle ?? "Rig";
  switch (type) {
    case "hello":
      for (const a of ev.awaiting ?? []) for (const c of a.callIds) waiting.set(`${a.runId}:${c}`, { sessionId: a.sessionId, tool: "a tool" });
      break;
    case "approval_requested":
      waiting.set(`${ev.runId}:${ev.callId}`, { sessionId: ev.sessionId, title: ev.sessionTitle, tool: ev.name ?? "a tool" });
      if (away) {
        notify(`Approval needed: ${ev.name}`, title, hash);
        win?.flashFrame(true);
      }
      break;
    case "approval_resolved":
      waiting.delete(`${ev.runId}:${ev.callId}`);
      break;
    case "run_completed":
    case "run_failed":
    case "run_cancelled":
      for (const k of [...waiting.keys()]) if (k.startsWith(`${ev.runId}:`)) waiting.delete(k);
      if (away && type !== "run_cancelled") notify(type === "run_completed" ? "Done" : "Run failed", type === "run_failed" ? `${title}: ${ev.error?.message ?? ""}` : title, hash);
      break;
    default:
      return;
  }
  refreshTray();
}

// ---------- lifecycle ----------

function quit(): void {
  quitting = true;
  app.quit();
}

app.on("before-quit", () => {
  quitting = true;
  saveState();
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopRuntime();
});
// Rig lives in the tray; closing the last window does not quit it.
app.on("window-all-closed", () => {});
app.on("activate", () => show());

function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}
