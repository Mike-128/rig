import type { RunStatus } from "./events";
import type { Usage } from "./canonical";

export type SessionKind = "chat" | "workbench" | "task";

/**
 * How much the user wants to be asked, chosen per session and changeable mid-run.
 * - default:     the agent's approval list decides
 * - acceptEdits: file edits run without asking; other approval-gated tools still ask
 * - plan:        read-only; the agent investigates and proposes, nothing changes
 * - auto:        everything the agent is allowed to use runs without asking
 */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto";

export interface Session {
  id: string;
  kind: SessionKind;
  agentSlug: string;
  agentVersion: number;
  workspace: string;
  title: string;
  /** How much the user wants to be asked; see PermissionMode. */
  mode: PermissionMode;
  /** "Always allow" rules recorded during this session, e.g. "file_edit" or "shell:npm test". */
  allowRules: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  sessionId: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  usage?: Usage;
  costUsd?: number;
  error?: string;
}

export interface AgentSummary {
  slug: string;
  name: string;
  description?: string;
  version: number;
  updatedAt: string;
}
