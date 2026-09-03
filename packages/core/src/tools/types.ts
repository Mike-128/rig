import type { ToolDefinition } from "../types";

export interface ToolContext {
  workspace: string;
  sandbox: 0 | 1;
  signal: AbortSignal;
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
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
