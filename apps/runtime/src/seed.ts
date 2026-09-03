import type { AppContext } from "./context";

/** The default chat assistant, created on first start if no agents exist. */
export function seedDefaults(app: AppContext): void {
  if (app.agents.list().length) return;
  app.agents.save({
    name: "Assistant",
    slug: "assistant",
    description: "Default chat assistant. Uses the model bound to the \"default\" alias.",
    model: { alias: "default" },
    instructions:
      "You are a helpful, direct assistant. Answer concisely. When a question needs current information from the web, use web_fetch. When the user refers to files in the workspace, read them with file_read before answering.",
    tools: ["web_fetch", "file_read"],
    sandbox: 1,
    approvals: [],
    budget: { maxTurns: 10 },
    params: {},
  });
}
