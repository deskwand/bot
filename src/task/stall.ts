/** How long a running task may go without observable activity before it counts as stalled. */
export const STALL_AFTER_MS = 600_000;

export type TaskActivity =
  | { kind: "waiting_model" }
  | { kind: "running_tool"; tool: string };

export type StallStore = {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
};

export type StallCheck =
  | { due: "notify"; activity: TaskActivity; idleMs: number }
  | { due: "later"; at: number };

/** The whole watch state in one row: the clock, the step, and when it was reported. */
type StallRecord = {
  at: number;
  activity: TaskActivity;
  notifiedAt: number | null;
};

const RECORD_KEY = "activity";
// The three-key layout that objects created before this change still carry.
const LEGACY_ACTIVITY_AT = "activity_at";
const LEGACY_ACTIVITY_STATE = "activity_state";
const LEGACY_STALL_NOTIFIED_AT = "stall_notified_at";

export class StallWatch {
  private readonly store: StallStore;
  private readonly afterMs: number;

  constructor(store: StallStore, afterMs: number = STALL_AFTER_MS) {
    this.store = store;
    this.afterMs = afterMs;
  }

  /** One row per event: the three-key layout wrote three. */
  record(activity: TaskActivity, now: number): void {
    this.store.write(
      RECORD_KEY,
      JSON.stringify({ at: now, activity, notifiedAt: null }),
    );
  }

  check(now: number): StallCheck {
    const record = readRecord(this.store);
    if (record === null || record.notifiedAt !== null) {
      return { due: "later", at: now + this.afterMs };
    }

    const idleMs = now - record.at;
    if (idleMs < this.afterMs) {
      return { due: "later", at: record.at + this.afterMs };
    }

    return { due: "notify", activity: record.activity, idleMs };
  }

  markNotified(now: number): void {
    const record = readRecord(this.store);
    if (record === null) return;
    this.store.write(
      RECORD_KEY,
      JSON.stringify({ ...record, notifiedAt: now }),
    );
  }

  /** The activity clock, or undefined when no event was ever recorded. */
  activityAt(): number | undefined {
    return readRecord(this.store)?.at;
  }

  /** The step last recorded, or undefined when none was. */
  activity(): TaskActivity | undefined {
    return readRecord(this.store)?.activity;
  }
}

function readRecord(store: StallStore): StallRecord | null {
  const raw = store.read(RECORD_KEY);
  if (raw !== undefined) return JSON.parse(raw) as StallRecord;

  const at = store.read(LEGACY_ACTIVITY_AT);
  if (at === undefined) return null;
  const state = store.read(LEGACY_ACTIVITY_STATE);
  const notifiedAt = store.read(LEGACY_STALL_NOTIFIED_AT) ?? "";
  return {
    at: Number(at),
    activity:
      state === undefined
        ? { kind: "waiting_model" }
        : (JSON.parse(state) as TaskActivity),
    notifiedAt: notifiedAt === "" ? null : Number(notifiedAt),
  };
}
