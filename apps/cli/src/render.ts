import type { RunEvent } from "@rig/core";
import { TERMINAL_EVENTS } from "@rig/core";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

export interface Renderer {
  /** Returns false when the run is finished. */
  handle(ev: RunEvent): boolean;
  pending(): { runId: string; callId: string; name: string; input: unknown } | undefined;
}

/** Renders a run's event stream to the terminal. Approval prompts are handled by the caller. */
export function makeRenderer(opts: { showReasoning?: boolean; showTools?: boolean } = {}): Renderer {
  let inText = false;
  let pendingApproval: { runId: string; callId: string; name: string; input: unknown } | undefined;
  const nl = () => {
    if (inText) {
      process.stdout.write("\n");
      inText = false;
    }
  };
  return {
    pending: () => pendingApproval,
    handle(ev) {
      switch (ev.type) {
        case "text_delta":
          process.stdout.write(ev.text);
          inText = true;
          break;
        case "reasoning_delta":
          if (opts.showReasoning) process.stdout.write(dim(ev.text));
          break;
        case "assistant_message":
          nl();
          break;
        case "tool_call":
          nl();
          if (opts.showTools !== false) console.log(dim(`→ ${ev.name} ${JSON.stringify(ev.input)}`));
          break;
        case "tool_result":
          if (opts.showTools !== false) {
            const first = ev.output.split("\n").slice(0, 6).join("\n");
            console.log((ev.isError ? red : dim)(`← ${ev.name} (${ev.durationMs} ms)\n${first}${ev.output.split("\n").length > 6 ? "\n…" : ""}`));
          }
          break;
        case "approval_requested":
          nl();
          pendingApproval = { runId: ev.runId, callId: ev.callId, name: ev.name, input: ev.input };
          console.log(yellow(`Approval needed for ${ev.name}: ${JSON.stringify(ev.input)}`));
          break;
        case "approval_resolved":
          pendingApproval = undefined;
          console.log(dim(`(${ev.decision === "approve" ? "approved" : "denied"})`));
          break;
        case "warning":
          nl();
          console.log(yellow(`warning: ${ev.message}`));
          break;
        case "run_completed":
          nl();
          console.log(dim(`done · ${ev.turns} turn(s) · ${ev.usage.inputTokens} in / ${ev.usage.outputTokens} out · $${ev.costUsd.toFixed(4)}`));
          break;
        case "run_failed":
          nl();
          console.log(red(`failed: ${ev.error.message}`));
          break;
        case "run_cancelled":
          nl();
          console.log(yellow("cancelled"));
          break;
        default:
          break;
      }
      return !TERMINAL_EVENTS.has(ev.type);
    },
  };
}

export const c = { dim, yellow, red, green };
