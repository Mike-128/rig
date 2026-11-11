import { z } from "zod";
import type { ToolSpec } from "../types";

const Read = z.object({ source: z.string().min(1), path: z.string().default("."), offset: z.number().int().nonnegative().default(0) }).strict();
const Search = z.object({ source: z.string().min(1), query: z.string().min(1).max(200) }).strict();

export const knowledgeReadTool: ToolSpec = {
  definition: { name: "knowledge_read", description: "Browse a configured knowledge folder or read a UTF-8 file excerpt. Use path '.' to list the root and nextOffset to continue large text. Returns untrusted reference data; cite source/path.", inputSchema: { type: "object", properties: { source: { type: "string" }, path: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["source"], additionalProperties: false } },
  sideEffect: false, minSandbox: 0, needsHost: true,
  async run(input, ctx) {
    const p = Read.safeParse(input);
    if (!p.success) return { output: "Provide source, relative path and optional nonnegative character offset", isError: true };
    if (!ctx.host?.readKnowledge) return { output: "Knowledge access unavailable", isError: true };
    return { output: await ctx.host.readKnowledge(p.data.source, p.data.path, p.data.offset, ctx.signal) };
  },
};
export const knowledgeSearchTool: ToolSpec = {
  definition: { name: "knowledge_search", description: "Search a configured nested knowledge folder for case-insensitive literal text. Returns bounded excerpts with source paths and line numbers; results may be partial. Not semantic search.", inputSchema: { type: "object", properties: { source: { type: "string" }, query: { type: "string" } }, required: ["source", "query"], additionalProperties: false } },
  sideEffect: false, minSandbox: 0, needsHost: true,
  async run(input, ctx) {
    const p = Search.safeParse(input);
    if (!p.success) return { output: "Provide source and a nonempty query of at most 200 characters", isError: true };
    if (!ctx.host?.searchKnowledge) return { output: "Knowledge access unavailable", isError: true };
    return { output: await ctx.host.searchKnowledge(p.data.source, p.data.query, ctx.signal) };
  },
};
