import type { ToolDefinition } from "../types";
import type { HostServices } from "./host";

export interface SubagentRequest {
  /** Short label shown to the user, e.g. "Find the auth middleware". */
  description: string;
  /** The full task, written so the sub-agent can do it without seeing this conversation. */
  prompt: string;
  /** Slug of the agent to run; omitted means a general-purpose helper with the parent's model. */
  agent?: string;
}

export interface ConversationRequest {
  /** Slug of the agent to start a conversation with. */
  agent?: string;
  /** Id of an existing conversation to continue. */
  conversation?: string;
  /** What to say. */
  message: string;
}

export interface ToolContext {
  workspace: string;
  sandbox: 0 | 1;
  signal: AbortSignal;
  /** Present when the runtime lends rig-management capabilities to this run. */
  host?: HostServices;
  /** Skills enabled for the running agent, by name ("*" for all). */
  enabledSkills?: string[];
  /** Streams partial output to the user while the tool runs (shell output, sub-agent progress). */
  onProgress?: (text: string) => void;
  /** Runs a sub-agent to completion and returns its final answer. Absent when nesting is not allowed. */
  runSubagent?: (req: SubagentRequest, ctx: { signal: AbortSignal; onProgress?: (text: string) => void }) => Promise<ToolResult>;
  /** Sends a message to another agent in a saved conversation and returns its reply. */
  messageAgent?: (req: ConversationRequest, ctx: { signal: AbortSignal; onProgress?: (text: string) => void }) => Promise<ToolResult>;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export interface ToolSpec {
  definition: ToolDefinition;
  /** Read-only tools are parallel-safe and never need approval by default. */
  sideEffect: boolean;
  /** Minimum sandbox level required to run. */
  minSandbox: 0 | 1;
  /** Requires runtime host services (agent, model, and skill management). */
  needsHost?: boolean;
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
