import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PERMISSION_MODES, type PermissionMode } from "@rig/core";

/**
 * Preferences the user sets in the Settings page, kept in ~/.rig/settings.json. Everything is
 * optional: an unset field means Rig's built-in default, so an empty file is a valid one.
 */
export const SettingsSchema = z.object({
  /** Agent a new session in a project folder starts with. Built-in default: coder. */
  projectAgent: z.string().min(1).optional(),
  /** Agent a new chat without a folder starts with. Built-in default: assistant. */
  chatAgent: z.string().min(1).optional(),
  /** Permission mode a new session starts in. Built-in default: ask before changes. */
  defaultMode: z.enum(PERMISSION_MODES as [PermissionMode, ...PermissionMode[]]).optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export class SettingsStore {
  private readonly file: string;

  constructor(home: string) {
    this.file = path.join(home, "settings.json");
  }

  get(): Settings {
    if (!existsSync(this.file)) return {};
    try {
      const parsed = SettingsSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  set(next: Settings): Settings {
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== "")) as Settings;
    writeFileSync(this.file, JSON.stringify(clean, null, 2) + "\n");
    return clean;
  }
}
