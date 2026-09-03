import type { RunStatus } from "./events";
import type { Usage } from "./canonical";

export type SessionKind = "chat" | "workbench" | "task";

export interface Session {
  id: string;
  kind: SessionKind;
  agentSlug: string;
  agentVersion: number;
  workspace: string;
  title: string;
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
