import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startServer } from "../src/server";

/** The seeded Assistant gains document_create on upgrade, unless the user has made it their own. */
describe("Assistant upgrade", () => {
  const OLD_INSTRUCTIONS =
    "You are a helpful, direct assistant. Answer concisely. When a question needs current information from the web, use web_fetch. When the user refers to files in the workspace, read them with file_read before answering.";

  async function restartWith(def: Record<string, unknown>): Promise<{ tools: string[]; instructions: string; version: number }> {
    const home = mkdtempSync(path.join(os.tmpdir(), "rig-assistant-"));
    try {
      const first = await startServer({ home, port: 0 }, { fileSecrets: true });
      // Put the Assistant back to what an earlier version seeded (or a user's edit of it).
      const saved = first.app.agents.save({ ...first.app.agents.get("assistant")!, ...def }, { knownSkills: first.app.skills.names() });
      expect(saved.ok).toBe(true);
      await first.close();
      const second = await startServer({ home, port: 0 }, { fileSecrets: true });
      const a = second.app.agents.get("assistant")!;
      await second.close();
      return { tools: [...a.tools], instructions: a.instructions, version: a.version };
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  it("adds document_create to an Assistant nobody edited", async () => {
    const a = await restartWith({ instructions: OLD_INSTRUCTIONS, tools: ["web_fetch", "file_read"] });
    expect(a.tools).toEqual(["web_fetch", "file_read", "document_create"]);
    expect(a.instructions).toContain("document_create");
  });

  it("leaves an Assistant the user edited alone", async () => {
    const a = await restartWith({ instructions: "Answer like a pirate.", tools: ["web_fetch", "file_read"] });
    expect(a.tools).toEqual(["web_fetch", "file_read"]);
    expect(a.instructions).toBe("Answer like a pirate.");
  });
});
