/**
 * What the Electron shell adds to the page (see apps/desktop/src/preload.cjs). In a plain browser
 * none of it exists, and the UI falls back: a typed folder path instead of a picker, and no tray.
 */
export interface DesktopBridge {
  isDesktop: true;
  pickFolder(): Promise<string | null>;
  openPath(p: string): Promise<void>;
}

declare global {
  interface Window {
    rig?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined = typeof window !== "undefined" ? window.rig : undefined;

/** Ctrl on Windows and Linux, Cmd on macOS. */
export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
export const modKey = (e: KeyboardEvent | React.KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);
export const modLabel = isMac ? "⌘" : "Ctrl";
