#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

// Dev-mode launcher: runs the TypeScript source through tsx.
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "index.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const child = spawn(tsx, [entry, ...process.argv.slice(2)], { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
