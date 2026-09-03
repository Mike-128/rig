import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import path from "node:path";

export interface SecretStore {
  backend: string;
  set(id: string, secret: string): Promise<void>;
  get(id: string): Promise<string | undefined>;
  delete(id: string): Promise<void>;
}

const SERVICE = "rig";
/** Keychain service name used before the project was renamed. Read once, then copied forward. */
const LEGACY_SERVICE = "harness";

/** OS keychain via @napi-rs/keyring (Credential Manager on Windows, Keychain on macOS, Secret Service on Linux). */
async function keyringStore(): Promise<SecretStore | undefined> {
  try {
    const mod = (await import("@napi-rs/keyring")) as { Entry: new (service: string, account: string) => { setPassword(p: string): void; getPassword(): string | null; deletePassword(): boolean } };
    const probe = new mod.Entry(SERVICE, "__probe__");
    probe.setPassword("ok");
    if (probe.getPassword() !== "ok") return undefined;
    probe.deletePassword();
    return {
      backend: "os-keychain",
      async set(id, secret) {
        new mod.Entry(SERVICE, id).setPassword(secret);
      },
      async get(id) {
        try {
          const found = new mod.Entry(SERVICE, id).getPassword();
          if (found !== null) return found;
        } catch {
          /* fall through to the legacy lookup */
        }
        try {
          const legacy = new mod.Entry(LEGACY_SERVICE, id).getPassword();
          if (legacy !== null) {
            new mod.Entry(SERVICE, id).setPassword(legacy);
            return legacy;
          }
        } catch {
          /* nothing stored under either name */
        }
        return undefined;
      },
      async delete(id) {
        try {
          new mod.Entry(SERVICE, id).deletePassword();
        } catch {
          /* missing */
        }
      },
    };
  } catch {
    return undefined;
  }
}

/** Fallback: AES-256-GCM files under RIG_HOME/secrets with a per-install key. Weaker than the keychain; warned at startup. */
function fileStore(home: string): SecretStore {
  const dir = path.join(home, "secrets");
  mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, ".key");
  let key: Buffer;
  if (existsSync(keyPath)) key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
  else {
    key = randomBytes(32);
    writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      /* windows */
    }
  }
  const file = (id: string) => path.join(dir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.enc`);
  return {
    backend: "encrypted-file",
    async set(id, secret) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([c.update(secret, "utf8"), c.final()]);
      const tag = c.getAuthTag();
      writeFileSync(file(id), JSON.stringify({ iv: iv.toString("hex"), tag: tag.toString("hex"), data: enc.toString("hex") }), { mode: 0o600 });
    },
    async get(id) {
      const p = file(id);
      if (!existsSync(p)) return undefined;
      const { iv, tag, data } = JSON.parse(readFileSync(p, "utf8"));
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
      d.setAuthTag(Buffer.from(tag, "hex"));
      return Buffer.concat([d.update(Buffer.from(data, "hex")), d.final()]).toString("utf8");
    },
    async delete(id) {
      const p = file(id);
      if (existsSync(p)) unlinkSync(p);
    },
  };
}

export async function openSecretStore(home: string, opts: { forceFile?: boolean } = {}): Promise<SecretStore> {
  if (!opts.forceFile) {
    const k = await keyringStore();
    if (k) return k;
  }
  return fileStore(home);
}
