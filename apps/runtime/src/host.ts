import { agentToYaml, type AgentDefinition, type HostModelSummary, type HostServices, type HostWriteResult } from "@rig/core";
import type { AppContext } from "./context";
import { readKnowledge, searchKnowledge } from "./knowledge";

/**
 * The runtime's implementation of the capabilities lent to rig-management tools.
 * Agents reach the agent, model, and skill stores only through this surface.
 */
export function createHost(app: AppContext, agent?: AgentDefinition): HostServices {
  return {
    readKnowledge: (source, file, offset, signal) => readKnowledge(agent?.knowledge, source, file, offset, signal),
    searchKnowledge: (source, query, signal) => searchKnowledge(agent?.knowledge, source, query, signal),
    readMemory: async () => {
      if (!agent?.memory) throw new Error("Persistent memory is not enabled for this agent");
      const row = app.db.prepare("SELECT content FROM agent_memory WHERE slug = ?").get(agent.slug) as { content: string } | undefined;
      return row?.content ?? "";
    },
    writeMemory: async (content, expectedContent) => {
      if (!agent?.memory || agent.sandbox < 1) throw new Error("Writable memory is not enabled for this agent");
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
      const res = app.agents.save(definition, { knownSkills: app.skills.names(), deriveSlug: true });
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

    listSkills: () => app.skills.list(),
    readSkill: (name) => app.skills.get(name),
    readSkillFile: (name, file) => app.skills.readFile(name, file),
    writeSkill: (name, description, body) => app.skills.write(name, description, body),
  };
}
