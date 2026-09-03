import type { ToolDefinition } from "../types";
import type { HostServices } from "./host";

export interface ToolContext {
  workspace: string;
  sandbox: 0 | 1;
  signal: AbortSignal;
  /** Present when the runtime lends rig-management capabilities to this run. */
  host?: HostServices;
  /** Skills enabled for the running agent, by name. */
  enabledSkills?: string[];
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
