import { agentToYaml, type HostModelSummary, type HostServices, type HostWriteResult } from "@rig/core";
import type { AppContext } from "./context";

/**
 * The runtime's implementation of the capabilities lent to rig-management tools.
 * Agents reach the agent, model, and skill stores only through this surface.
 */
export function createHost(app: AppContext, workspace?: string): HostServices {
  return {
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
  };
}
