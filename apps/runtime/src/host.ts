import { agentToYaml, renderMemory, validateMemoryInput, type AgentDefinition, type HostModelSummary, type HostServices, type HostWriteResult } from "@rig/core";
import { today } from "./stores/memory";
import type { AppContext } from "./context";
import { readKnowledge, searchKnowledge } from "./knowledge";

/**
 * The runtime's implementation of the capabilities lent to rig-management tools.
 * Agents reach the agent, model, and skill stores only through this surface.
 */
/** agent scopes the knowledge folders and the notebook; workspace scopes project skills. */
export function createHost(app: AppContext, agent?: AgentDefinition, workspace?: string): HostServices {
  return {
    readKnowledge: (source, file, offset, signal) => readKnowledge(agent?.knowledge, source, file, offset, signal),
    searchKnowledge: (source, query, signal) => searchKnowledge(agent?.knowledge, source, query, signal),
    readNotes: async () => {
      if (!agent?.memory) throw new Error("Persistent notes are not enabled for this agent");
      const row = app.db.prepare("SELECT content FROM agent_memory WHERE slug = ?").get(agent.slug) as { content: string } | undefined;
      return row?.content ?? "";
    },
    writeNotes: async (content, expectedContent) => {
      if (!agent?.memory || agent.sandbox < 1) throw new Error("Writable notes are not enabled for this agent");
      if (content.length > 24000 || expectedContent.length > 24000) throw new Error("Memory is limited to 24000 characters");
      const result = app.db.prepare(`INSERT INTO agent_memory (slug, content, updated_at)
        SELECT ?, ?, ? WHERE ? = '' OR EXISTS (SELECT 1 FROM agent_memory WHERE slug = ? AND content = ?)
        ON CONFLICT(slug) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at WHERE agent_memory.content = ?`)
        .run(agent.slug, content, new Date().toISOString(), expectedContent, agent.slug, expectedContent, expectedContent);
      if (!result.changes) throw new Error("Memory changed since it was read. Read it again and merge your notes before retrying.");
      return "Persistent notes saved";
    },
    listAgents: () => app.agents.list().map((a) => ({ slug: a.slug, name: a.name, description: a.description, version: a.version })),

    readAgentYaml: (slug) => app.agents.getYaml(slug),

    writeAgent: (definition): HostWriteResult => {
      const res = app.agents.save(definition, { knownSkills: app.skills.names(workspace), deriveSlug: true });
      return {
        ok: res.ok,
        issues: res.issues,
        slug: res.saved?.slug,
        version: res.saved?.version,
        yaml: res.saved ? agentToYaml(res.saved) : undefined,
      };
    },

    listModels: (): HostModelSummary[] => {
      const conns = new Map(app.connections.list().map((c) => [c.id, c.name]));
      const aliases = app.models.listAliases();
      return app.models.list().map((m) => ({
        connection: conns.get(m.connectionId) ?? m.connectionId,
        model: m.providerModelId,
        dialect: m.dialect,
        status: m.status,
        reasoning: m.capabilities.reasoning,
        aliases: aliases.filter((a) => a.connectionId === m.connectionId && a.modelId === m.providerModelId).map((a) => a.alias),
      }));
    },

    listSkills: () => app.skills.list(workspace),
    readSkill: (name) => app.skills.get(name, workspace),
    readSkillFile: (name, file) => app.skills.readFile(name, file, workspace),
    writeSkill: (name, description, body) => app.skills.write(name, description, body),

    listMemories: () => app.memory.list(),
    readMemory: (name, scope) => app.memory.get(name, scope),
    writeMemory: async (scope, change) => {
      const author = app.github.status()?.login;
      if (scope === "personal") {
        if ("delete" in change) {
          return app.memory.deletePersonal(change.name) ? { ok: true, message: `Removed personal memory "${change.name}".` } : { ok: false, error: `No personal memory named "${change.name}".` };
        }
        const r = app.memory.writePersonal(change, author);
        return r.ok ? { ok: true, message: `Saved personal memory "${change.name}".` } : r;
      }
      if (!app.team.config()) return { ok: false, error: "No team repository is connected, so team memory is unavailable. Save it as personal, or connect a team repo on the Team page." };
      try {
        if ("delete" in change) {
          if (!app.memory.get(change.name, "team")) return { ok: false, error: `No team memory named "${change.name}".` };
          app.team.stage({ kind: "memory", name: change.name, op: "delete", files: {}, summary: `remove memory "${change.name}"`, origin: "agent" });
        } else {
          const err = validateMemoryInput(change);
          if (err) return { ok: false, error: err };
          const text = renderMemory({ ...change, author, updated: today() });
          app.team.stage({
            kind: "memory",
            name: change.name,
            op: "upsert",
            files: { [`memory/${change.name}.md`]: Buffer.from(text).toString("base64") },
            summary: change.description,
            origin: "agent",
          });
        }
        return {
          ok: true,
          message: `Proposed to the team. It is queued in Rig's Team page; once the user opens a pull request and a teammate approves and merges it, everyone's agents will see it. Until then it is not in effect.`,
        };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  };
}
