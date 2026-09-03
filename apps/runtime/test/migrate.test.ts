import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateHomeDirectory } from "../src/config";

describe("legacy home migration", () => {
  const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rig-migrate-"));

  it("carries the SQLite sidecars across with the database", () => {
    const root = tmp();
    const legacy = path.join(root, ".harness");
    const target = path.join(root, ".rig");
    mkdirSync(path.join(legacy, "agents"), { recursive: true });
    // A -wal can hold committed rows not yet folded into the main file. Renaming the database
    // without it silently loses that data, which is exactly what this guards against.
    writeFileSync(path.join(legacy, "harness.db"), "main");
    writeFileSync(path.join(legacy, "harness.db-wal"), "pending-writes");
    writeFileSync(path.join(legacy, "harness.db-shm"), "shared-memory");
    writeFileSync(path.join(legacy, "agents", "a.yaml"), "name: A");

    expect(migrateHomeDirectory(legacy, target, path.join(target, "rig.db"))).toBe(true);

    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(path.join(target, "rig.db"), "utf8")).toBe("main");
    expect(readFileSync(path.join(target, "rig.db-wal"), "utf8")).toBe("pending-writes");
    expect(readFileSync(path.join(target, "rig.db-shm"), "utf8")).toBe("shared-memory");
    expect(readFileSync(path.join(target, "agents", "a.yaml"), "utf8")).toBe("name: A");
    expect(existsSync(path.join(target, "harness.db"))).toBe(false);
    expect(existsSync(path.join(target, "harness.db-wal"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("never overwrites an existing home, and is a no-op without a legacy one", () => {
    const root = tmp();
    const legacy = path.join(root, ".harness");
    const target = path.join(root, ".rig");
    mkdirSync(legacy, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(legacy, "harness.db"), "old");
    writeFileSync(path.join(target, "rig.db"), "current");

    expect(migrateHomeDirectory(legacy, target, path.join(target, "rig.db"))).toBe(false);
    expect(readFileSync(path.join(target, "rig.db"), "utf8")).toBe("current");
    expect(existsSync(legacy)).toBe(true);

    rmSync(legacy, { recursive: true, force: true });
    expect(migrateHomeDirectory(legacy, path.join(root, ".rig2"), path.join(root, ".rig2", "rig.db"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
