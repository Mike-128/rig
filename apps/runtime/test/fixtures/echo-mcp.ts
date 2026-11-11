/** A minimal stdio MCP server for tests: one read-only tool and one that "writes". */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });

server.registerTool(
  "echo",
  { description: "Echo the text back.", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);

server.registerTool(
  "save.note",
  { description: "Pretend to save a note.", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: `saved: ${text}` }] }),
);

await server.connect(new StdioServerTransport());
