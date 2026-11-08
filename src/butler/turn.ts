import type { LiveState } from "@earendil-works/pi-durable";

/** How long a running turn may show no change before it counts as stalled. */
export const TURN_STALL_MS = 300_000;
/** The regular beat while a turn is unfinished. */
export const TURN_CHECK_EVERY_MS = 60_000;
/** Alarms cannot be trusted with sub-second delays; keep a floor. */
export const TURN_EARLIEST_GAP_MS = 1_000;
/** How long a parked turn may stay parked after one retry before it is dropped. */
export const TURN_PARKED_GRACE_MS = 60_000;

/** Backoff before the next delivery attempt, by the number of failed sends. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

export function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts, 1), 3) - 1]!;
}

export type TurnPhase = "queued" | "running" | "parked";

export type TurnActivity =
  | { kind: "waiting_model" }
  | { kind: "running_tool"; tool: string };

export type TurnCheckInput = {
  now: number;
  phase: TurnPhase;
  activity: TurnActivity;
  activityAt: number;
  noticeAt: number | null;
};

export type TurnCheckPlan = {
  send: null | { kind: "stall"; activity: TurnActivity; idleMs: number };
  nextAt: number;
};

type SlotLike = {
  name: string;
  status: string;
  output?: string;
  droppedBytes?: number;
};

function slotKey(call: SlotLike): string {
  return `${call.name}:${call.status}:${call.output?.length ?? 0}:${call.droppedBytes ?? 0}`;
}

/** What pi is doing, stable across checks so a change is visible. */
export function signatureOf(live: LiveState | undefined): string {
  if (live === undefined) return "";
  const partial = live.generation?.message;
  return JSON.stringify({
    run: live.run !== undefined,
    attempt: live.generation?.attempt,
    retryAt: live.generation?.retry?.at,
    partial: partial === undefined ? 0 : JSON.stringify(partial).length,
    tools: (live.tools ?? []).map(slotKey),
    nested: (live.nestedTools ?? []).map(slotKey),
    compactions: (live.compactions ?? []).length,
  });
}

/** The last thing pi was doing: which tool, or waiting on the model. */
export function activityOf(live: LiveState | undefined): TurnActivity {
  const running = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].filter(
    (call) => call.status === "running",
  );
  const call = running[running.length - 1];
  return call === undefined
    ? { kind: "waiting_model" }
    : { kind: "running_tool", tool: call.name };
}

/** When this turn next needs a look, and whether it needs to say something now. */
export function planTurnCheck(input: TurnCheckInput): TurnCheckPlan {
  const running = input.phase === "running";
  const stallDue = running && input.noticeAt === null;

  const idleMs = input.now - input.activityAt;
  let send: TurnCheckPlan["send"] = null;
  if (running && idleMs >= TURN_STALL_MS && input.noticeAt === null) {
    send = { kind: "stall", activity: input.activity, idleMs };
  }

  // Just spoke: the deadline it answered is behind us. Come back on the beat
  // instead of re-checking one second later.
  if (send !== null) {
    return { send, nextAt: input.now + TURN_CHECK_EVERY_MS };
  }

  const candidates = [input.now + TURN_CHECK_EVERY_MS];
  if (stallDue) candidates.push(input.activityAt + TURN_STALL_MS);

  return {
    send,
    nextAt: Math.max(
      Math.min(...candidates),
      input.now + TURN_EARLIEST_GAP_MS,
    ),
  };
}
