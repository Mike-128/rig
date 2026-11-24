import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventBody } from "@rig/core/types";
import { emptyThread, reduceAll, reduceEvent } from "./events";

function event(body: RunEventBody, ms: number, runId = "run-one"): RunEvent {
  return { ...body, ts: new Date(ms).toISOString(), runId, sessionId: "session", id: ms };
}
const reply: RunEventBody = { type: "assistant_message", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] }, stopReason: "end_turn" };
describe("approvals another agent asks for", () => {
  it("names the agent, and closes the card with the decision since the call runs in its conversation", () => {
    const via = { agent: "Research", conversation: "sess_convo" };
    const asked = reduceAll([event({ type: "approval_requested", callId: "run-two.call_1", name: "file_read", input: { path: "notes.md" }, via }, 1000)]);
    expect(asked.status).toBe("awaiting_approval");
    expect(asked.items[0]).toMatchObject({ kind: "tool", name: "file_read", status: "awaiting_approval", via });
    const allowed = reduceEvent(asked, event({ type: "approval_resolved", callId: "run-two.call_1", decision: "approve" }, 1100));
    expect(allowed.items[0]).toMatchObject({ status: "done", approval: { decision: "approve" } });
    expect(allowed.status).toBe("running");
  });
});

describe("chat response latency", () => {
  it("uses identical persisted timing during live delivery and replay", () => {
    const events = [event({ type: "turn_started", turn: 1 }, 1000), event(reply, 2234)];
    const live = events.reduce(reduceEvent, emptyThread());
    expect(live).toEqual(reduceAll(events));
    expect(live.items[0]).toMatchObject({ kind: "assistant", latencyMs: 1234 });
  });
  it("measures each model turn separately, excluding intervening tool or approval time", () => {
    const state = reduceAll([
      event({ type: "turn_started", turn: 1 }, 1000), event(reply, 2000),
      event({ type: "turn_started", turn: 2 }, 60000), event(reply, 60200),
    ]);
    expect(state.items).toMatchObject([{ latencyMs: 1000 }, { latencyMs: 200 }]);
  });
  it("does not invent timing for missing, invalid, reversed or other-run timestamps", () => {
    expect(reduceAll([event(reply, 1000)]).items[0]).toMatchObject({ latencyMs: undefined });
    for (const start of [event({ type: "turn_started", turn: 1 }, 2000), { ...event({ type: "turn_started", turn: 1 }, 0), ts: "invalid" }, event({ type: "turn_started", turn: 1 }, 0, "another-run")]) {
      expect(reduceAll([start, event(reply, 1000)]).items[0]).toMatchObject({ latencyMs: undefined });
    }
    expect(reduceAll([event({ type: "turn_started", turn: 1 }, 1000), event(reply, 1000)]).items[0]).toMatchObject({ latencyMs: 0 });
  });
});
