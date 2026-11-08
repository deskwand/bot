import type { LiveState } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  activityOf,
  planTurnCheck,
  retryDelayMs,
  signatureOf,
  TURN_ACK_MS,
  TURN_CHECK_EVERY_MS,
  TURN_STALL_MS,
  type TurnCheckInput,
} from "../../src/butler/turn";

function live(patch: Partial<LiveState> = {}): LiveState {
  return { ...patch };
}

function input(patch: Partial<TurnCheckInput> = {}): TurnCheckInput {
  return {
    now: 10_000,
    phase: "running",
    activity: { kind: "waiting_model" },
    startedAt: 0,
    activityAt: 0,
    ackAt: null,
    spokeAt: null,
    noticeAt: null,
    ...patch,
  };
}

describe("signatureOf", () => {
  it("is empty without a live state", () => {
    expect(signatureOf(undefined)).toBe("");
  });

  it("changes when a tool call changes status", () => {
    const running = live({
      tools: [{ callId: "a", name: "web_fetch", status: "running" }],
    });
    const done = live({
      tools: [{ callId: "a", name: "web_fetch", status: "done" }],
    });
    expect(signatureOf(running)).not.toBe(signatureOf(done));
  });

  it("changes as streamed partial text grows", () => {
    const first = live({
      generation: {
        attempt: 1,
        message: { role: "assistant", content: [] } as never,
      },
    });
    const second = live({
      generation: {
        attempt: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        } as never,
      },
    });
    expect(signatureOf(first)).not.toBe(signatureOf(second));
  });

  it("is stable for the same state", () => {
    const state = live({
      tools: [{ callId: "a", name: "web_fetch", status: "running" }],
    });
    expect(signatureOf(state)).toBe(signatureOf(state));
  });
});

describe("activityOf", () => {
  it("waits on the model when nothing runs", () => {
    expect(activityOf(undefined)).toEqual({ kind: "waiting_model" });
  });

  it("names the running tool", () => {
    expect(
      activityOf(
        live({ tools: [{ callId: "a", name: "web_fetch", status: "running" }] }),
      ),
    ).toEqual({ kind: "running_tool", tool: "web_fetch" });
  });

  it("prefers the newest nested call", () => {
    expect(
      activityOf(
        live({
          tools: [{ callId: "a", name: "codemode", status: "running" }],
          nestedTools: [
            {
              callId: "a/1",
              parentCallId: "a",
              parentTaskId: 1 as never,
              taskId: 2 as never,
              name: "web_fetch",
              status: "running",
              arguments: {},
            },
          ],
        }),
      ),
    ).toEqual({ kind: "running_tool", tool: "web_fetch" });
  });
});

describe("planTurnCheck", () => {
  it("stays quiet before the ack deadline", () => {
    expect(planTurnCheck(input({ now: TURN_ACK_MS - 1 })).send).toBeNull();
  });

  it("acknowledges at the deadline", () => {
    expect(planTurnCheck(input({ now: TURN_ACK_MS })).send).toEqual({
      kind: "ack",
    });
  });

  it("does not acknowledge a turn that already spoke", () => {
    expect(planTurnCheck(input({ now: TURN_ACK_MS, spokeAt: 1 })).send).toBeNull();
  });

  it("acknowledges once", () => {
    expect(planTurnCheck(input({ now: TURN_ACK_MS, ackAt: 5 })).send).toBeNull();
  });

  it("stays quiet while the turn is queued", () => {
    expect(
      planTurnCheck(input({ now: 60_000, phase: "queued" })).send,
    ).toBeNull();
  });

  it("reports a stall after the threshold", () => {
    const plan = planTurnCheck(input({ now: TURN_STALL_MS, activityAt: 0 }));
    expect(plan.send).toEqual({
      kind: "stall",
      activity: { kind: "waiting_model" },
      idleMs: TURN_STALL_MS,
    });
  });

  it("sends the stall instead of the ack when both are due", () => {
    expect(planTurnCheck(input({ now: TURN_STALL_MS })).send?.kind).toBe("stall");
  });

  it("does not report the same stall twice", () => {
    expect(
      planTurnCheck(input({ now: TURN_STALL_MS * 2, noticeAt: TURN_STALL_MS }))
        .send,
    ).toBeNull();
  });

  it("schedules the earliest of ack, stall, and the regular beat", () => {
    expect(planTurnCheck(input({ now: 2_000 })).nextAt).toBe(TURN_ACK_MS);
    expect(planTurnCheck(input({ now: 2_000, ackAt: 1 })).nextAt).toBe(
      2_000 + TURN_CHECK_EVERY_MS,
    );
    expect(
      planTurnCheck(input({ now: 2_000, ackAt: 1, noticeAt: 1 })).nextAt,
    ).toBe(2_000 + TURN_CHECK_EVERY_MS);
  });

  it("returns to the regular beat right after speaking", () => {
    expect(planTurnCheck(input({ now: TURN_ACK_MS })).nextAt).toBe(
      TURN_ACK_MS + TURN_CHECK_EVERY_MS,
    );
    expect(planTurnCheck(input({ now: TURN_STALL_MS })).nextAt).toBe(
      TURN_STALL_MS + TURN_CHECK_EVERY_MS,
    );
  });

  it("never returns a time in the past", () => {
    expect(
      planTurnCheck(input({ now: 10_000, ackAt: 1, noticeAt: 1 })).nextAt,
    ).toBeGreaterThan(10_000);
  });
});

describe("retryDelayMs", () => {
  it("backs off 30s, 2m, then 10m", () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(600_000);
    expect(retryDelayMs(9)).toBe(600_000);
  });
});
