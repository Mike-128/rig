import type { ToolSpec } from "../types";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** Present-tense form shown while the item is in progress, e.g. "Running the tests". */
  activeForm?: string;
}

/**
 * The plan lives in the tool call itself: the UI renders the latest todo_write input as the task
 * list, and replay rebuilds it from the event log like everything else.
 */
export const todoWriteTool: ToolSpec = {
  definition: {
    name: "todo_write",
    description:
      "Create or update your task list for the current work. Use it for multi-step tasks (three or more steps) so the user can follow progress: send the whole list every time, keep exactly one item in_progress while working, and mark items completed as soon as they are done. Skip it for simple one-step requests.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "The step, imperative: \"Run the tests\"." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              activeForm: { type: "string", description: "Present continuous: \"Running the tests\"." },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
  sideEffect: false,
  minSandbox: 0,
  async run(input) {
    const { todos } = (input ?? {}) as { todos?: Todo[] };
    if (!Array.isArray(todos)) return { output: "todos must be an array", isError: true };
    const done = todos.filter((t) => t.status === "completed").length;
    const active = todos.find((t) => t.status === "in_progress");
    return { output: `Task list updated: ${done}/${todos.length} done${active ? `; now: ${active.content}` : ""}. Keep it current as you work.` };
  },
};

export const taskTool: ToolSpec = {
  definition: {
    name: "task",
    description:
      "Delegate a self-contained task to a sub-agent that works in the same workspace and returns a single final report. Use it for broad searches or investigations that would flood your context, or to run independent pieces of work in parallel (call it several times in one turn). The sub-agent cannot see this conversation, so write a complete prompt: the goal, relevant paths, and exactly what to report back. It cannot ask you questions.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "A short (3-6 word) label for the task." },
        prompt: { type: "string", description: "The full task for the sub-agent." },
        agent: { type: "string", description: "Optional: slug of a saved agent to run instead of a general-purpose helper." },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
  },
  sideEffect: false,
  minSandbox: 0,
  async run(input, ctx) {
    const req = (input ?? {}) as { description?: string; prompt?: string; agent?: string };
    if (typeof req.prompt !== "string" || !req.prompt.trim()) return { output: "prompt is required", isError: true };
    if (!ctx.runSubagent) return { output: "Sub-agents are not available here (nested sub-agents are not allowed).", isError: true };
    return ctx.runSubagent(
      { description: req.description ?? "Sub-task", prompt: req.prompt, agent: req.agent },
      { signal: ctx.signal, onProgress: ctx.onProgress },
    );
  },
};
