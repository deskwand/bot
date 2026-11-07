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

const ACTIVITY_AT = "activity_at";
const ACTIVITY_STATE = "activity_state";
const STALL_NOTIFIED_AT = "stall_notified_at";

export class StallWatch {
  private readonly store: StallStore;
  private readonly afterMs: number;

  constructor(store: StallStore, afterMs: number = STALL_AFTER_MS) {
    this.store = store;
    this.afterMs = afterMs;
  }

  record(activity: TaskActivity, now: number): void {
    this.store.write(ACTIVITY_AT, String(now));
    this.store.write(ACTIVITY_STATE, JSON.stringify(activity));
    this.store.write(STALL_NOTIFIED_AT, "");
  }

  check(now: number): StallCheck {
    const activityAt = this.readActivityAt();
    if (activityAt === undefined) {
      return { due: "later", at: now + this.afterMs };
    }

    const notifiedAt = this.store.read(STALL_NOTIFIED_AT);
    if (notifiedAt !== undefined && notifiedAt !== "") {
      return { due: "later", at: now + this.afterMs };
    }

    const idleMs = now - activityAt;
    if (idleMs < this.afterMs) {
      return { due: "later", at: activityAt + this.afterMs };
    }

    return {
      due: "notify",
      activity: JSON.parse(this.store.read(ACTIVITY_STATE) ?? "") as TaskActivity,
      idleMs,
    };
  }

  markNotified(now: number): void {
    this.store.write(STALL_NOTIFIED_AT, String(now));
  }

  private readActivityAt(): number | undefined {
    const value = this.store.read(ACTIVITY_AT);
    return value === undefined ? undefined : Number(value);
  }
}
