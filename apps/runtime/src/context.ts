import type { RuntimeConfig } from "./config";
import type { Db } from "./db";
import type { SecretStore } from "./secrets";
import type { ConnectionStore } from "./stores/connections";
import type { ModelStore } from "./stores/models";
import type { AgentStore } from "./stores/agents";
import type { SessionStore } from "./stores/sessions";
import type { ProfileStore } from "./stores/profiles";
import type { SkillStore } from "./stores/skills";
import type { RunManager } from "./scheduler";
import type { McpManager } from "./mcp";
import type { GitHubAuth } from "./github";
import type { TeamManager } from "./team";
import type { MemoryStore } from "./stores/memory";

export interface AppContext {
  config: RuntimeConfig;
  db: Db;
  secrets: SecretStore;
  connections: ConnectionStore;
  models: ModelStore;
  agents: AgentStore;
  sessions: SessionStore;
  profiles: ProfileStore;
  skills: SkillStore;
  runs: RunManager;
  mcp: McpManager;
  github: GitHubAuth;
  team: TeamManager;
  memory: MemoryStore;
}
