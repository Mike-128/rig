import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { BUILTIN_PROFILES, type GatewayProfile } from "@rig/core";

/** Built-in profiles plus any JSON profiles dropped into RIG_HOME/profiles. */
export class ProfileStore {
  constructor(private dir: string) {}

  custom(): GatewayProfile[] {
    if (!existsSync(this.dir)) return [];
    const out: GatewayProfile[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const p = JSON.parse(readFileSync(path.join(this.dir, f), "utf8")) as GatewayProfile;
        if (p.id && p.baseUrl && p.auth?.headerName && Array.isArray(p.models)) out.push(p);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  }

  list(): GatewayProfile[] {
    const custom = this.custom();
    const customIds = new Set(custom.map((p) => p.id));
    return [...custom, ...BUILTIN_PROFILES.filter((p) => !customIds.has(p.id))];
  }

  get(id: string): GatewayProfile | undefined {
    return this.list().find((p) => p.id === id);
  }
}
