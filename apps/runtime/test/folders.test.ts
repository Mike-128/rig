import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { folderRoutes } from "../src/routes/folders";

interface Listing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
}

describe("project folder picker", () => {
  it("lists folders without reading or returning file contents and supports parent navigation", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rig-picker-"));
    try {
      mkdirSync(path.join(root, "Project with spaces"));
      writeFileSync(path.join(root, "private.txt"), "not a listing result");
      const app = folderRoutes();
      const response = await app.request(`/folders?path=${encodeURIComponent(root)}`);
      expect(response.status).toBe(200);
      const listing = await response.json() as Listing;
      expect(listing.entries).toEqual([{ name: "Project with spaces", path: path.join(listing.path, "Project with spaces") }]);
      expect(listing.parent).toBe(path.dirname(listing.path));
      expect(listing.truncated).toBe(false);
      const child = await (await app.request(`/folders?path=${encodeURIComponent(listing.entries[0].path)}`)).json() as Listing;
      expect(child.parent).toBe(listing.path);
      expect(child.entries).toEqual([]);
      expect((await app.request(`/folders?path=${encodeURIComponent(path.join(root, "private.txt"))}`)).status).toBe(400);
      expect((await app.request(`/folders?path=${encodeURIComponent(path.join(root, "missing"))}`)).status).toBe(400);
      expect((await app.request("/folders?path=relative")).status).toBe(400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
