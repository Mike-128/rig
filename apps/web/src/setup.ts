import { useCallback, useEffect, useState } from "react";
import type { PermissionMode } from "@rig/core/types";
import { api } from "./api";

/** Mirrors apps/runtime/src/routes/settings.ts. */
export interface SetupStatus {
  version: string;
  home: string;
  secrets: string;
  connections: number;
  entitledModels: number;
  defaultModel: { connection: string; model: string; status: string } | null;
  sessions: number;
  instructions: boolean;
  github: { host: string; login: string } | null;
  team: string | null;
  mcp: { configured: number; connected: number };
  skills: number;
  agents: number;
  ready: boolean;
}

export interface Settings {
  projectAgent?: string;
  chatAgent?: string;
  defaultMode?: PermissionMode;
}

/** What a probe result means, in the words the UI uses everywhere. */
export const STATUS_LABEL: Record<string, string> = {
  entitled: "Works",
  unauthorized: "Key rejected",
  forbidden: "Not allowed",
  not_found: "Not found",
  rate_limited: "Rate limited",
  unknown: "Unclear",
  listed: "Not tested",
  unprobed: "Not tested",
  missing: "Removed",
};

export const STATUS_HELP: Record<string, string> = {
  entitled: "A test request to this model succeeded.",
  unauthorized: "The provider rejected the key (401). Check the key, and the header it is sent in.",
  forbidden: "The key is valid but not allowed to use this model (403).",
  not_found: "The route or model id was not found (404). Check the base URL and the model id.",
  rate_limited: "The provider asked Rig to slow down (429). Test again in a minute.",
  unknown: "The test got an unexpected answer. The detail column has what came back.",
  listed: "The provider lists this model; it has not been tested yet.",
  unprobed: "Not tested yet. It may still work.",
  missing: "The default points at a model that no longer exists.",
};

/** Ask every open view to reload setup state, e.g. after a model or the default changes. */
export const announceSetupChange = () => window.dispatchEvent(new Event("rig:setup"));

export function useSetup(pollMs = 0): { setup: SetupStatus | null; refresh: () => void } {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const refresh = useCallback(() => {
    api<SetupStatus>("/setup")
      .then(setSetup)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener("rig:setup", refresh);
    const id = pollMs ? setInterval(refresh, pollMs) : undefined;
    return () => {
      window.removeEventListener("rig:setup", refresh);
      if (id) clearInterval(id);
    };
  }, [refresh, pollMs]);
  return { setup, refresh };
}
