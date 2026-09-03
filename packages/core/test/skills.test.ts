import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  isParseError,
  parseSkillMarkdown,
  renderSkillMarkdown,
  skillHash,
  validateAgentDefinition,
  type SkillSummary,
} from "../src";

const GOOD = `---
name: release-notes
description: House style for release notes.
---

Write in the past tense. Group by user-visible change.`;

describe("skill parsing", () => {
  it("parses frontmatter and body", () => {
    const r = parseSkillMarkdown(GOOD);
    expect(isParseError(r)).toBe(false);
    if (isParseError(r)) return;
    expect(r.name).toBe("release-notes");
    expect(r.description).toBe("House style for release notes.");
    expect(r.body).toMatch(/^Write in the past tense/);
  });

  it("rejects a missing or malformed header", () => {
    for (const bad of [
      "no frontmatter at all",
      "---\ndescription: only a description\n---\n\nbody",
      "---\nname: release-notes\n---\n\nbody",
      "---\nname: Release Notes\ndescription: d\n---\n\nbody",
      "---\nname: ok\ndescription: d\n---\n",
    ]) {
      expect(isParseError(parseSkillMarkdown(bad))).toBe(true);
    }
  });

  it("round-trips through the renderer, including values needing quotes", () => {
    const text = renderSkillMarkdown("pdf-forms", "Fill forms: including checkboxes.", "Body here.");
    const r = parseSkillMarkdown(text);
    expect(isParseError(r)).toBe(false);
    if (isParseError(r)) return;
    expect(r.description).toBe("Fill forms: including checkboxes.");
  });

  it("hashes content stably and distinguishes edits", () => {
    expect(skillHash(GOOD)).toBe(skillHash(GOOD));
    expect(skillHash(GOOD)).not.toBe(skillHash(GOOD + " "));
    expect(skillHash(GOOD)).toHaveLength(12);
  });
});

describe("system prompt", () => {
  const skills: SkillSummary[] = [
    { name: "release-notes", description: "House style for release notes.", hash: "a", source: "user", dir: "/x", files: [] },
    { name: "unused", description: "Not attached to this agent.", hash: "b", source: "user", dir: "/y", files: [] },
  ];
  const agentWith = (extra: Record<string, unknown>) =>
    validateAgentDefinition({ name: "A", slug: "a", model: { alias: "d" }, instructions: "Do the thing.", ...extra }).definition!;

  it("advertises only the skills the agent has attached", () => {
    const p = buildSystemPrompt(agentWith({ skills: ["release-notes"], tools: ["load_skill"] }), { skills, workspace: "/ws" });
    expect(p).toMatch(/^Do the thing\./);
    expect(p).toContain("release-notes: House style for release notes.");
    expect(p).not.toContain("unused");
    expect(p).toContain("load_skill");
  });

  it("omits the skills section when none are attached", () => {
    const p = buildSystemPrompt(agentWith({}), { skills });
    expect(p).not.toContain("Available skills");
  });

  it("states the workspace and read-only posture", () => {
    const p = buildSystemPrompt(agentWith({ sandbox: 0 }), { workspace: "/ws" });
    expect(p).toContain("/ws");
    expect(p).toContain("read-only");
  });
});

describe("agent validation with skills", () => {
  it("requires load_skill when skills are attached", () => {
    const v = validateAgentDefinition({ name: "A", slug: "a", model: { alias: "d" }, instructions: "i", skills: ["x"], tools: ["file_read"] });
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => /load_skill/.test(i.message))).toBe(true);
  });

  it("warns about skills that are not installed", () => {
    const v = validateAgentDefinition(
      { name: "A", slug: "a", model: { alias: "d" }, instructions: "i", skills: ["ghost"], tools: ["load_skill"] },
      { knownSkills: ["real"] },
    );
    expect(v.ok).toBe(true);
    expect(v.issues.some((i) => i.severity === "warning" && /ghost/.test(i.message))).toBe(true);
  });

  it("derives a slug from the name when asked, for tool-driven creation", () => {
    const v = validateAgentDefinition({ name: "Note Taker!", model: { alias: "d" }, instructions: "i" }, { deriveSlug: true });
    expect(v.ok).toBe(true);
    expect(v.definition?.slug).toBe("note-taker");
  });

  it("treats agent_write and skill_write as side effects worth approving", () => {
    const v = validateAgentDefinition({ name: "A", slug: "a", model: { alias: "d" }, instructions: "i", tools: ["agent_write", "skill_write"] });
    expect(v.ok).toBe(true);
    expect(v.issues.filter((i) => i.severity === "warning")).toHaveLength(2);
  });

  it("allows management tools at sandbox 0", () => {
    const v = validateAgentDefinition({
      name: "A",
      slug: "a",
      model: { alias: "d" },
      instructions: "i",
      tools: ["agent_write", "model_list"],
      approvals: ["agent_write"],
      sandbox: 0,
    });
    expect(v.ok).toBe(true);
  });
});
