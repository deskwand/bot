/** Timing source for progress throttling. Injectable so tests can advance time. */
export type Clock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

let clockOverride: Clock | null = null;

/** Test-only clock override, mirroring the channel and model overrides. */
export function setClockOverride(clock: Clock | null): void {
  clockOverride = clock;
}

/** The active clock: the test override, or the system clock. */
export function getClock(): Clock {
  return clockOverride ?? systemClock;
}

type PendingProgress = { text: string; dueAt: number };

/**
 * Per-task progress throttle. The first update after a quiet interval passes
 * immediately; updates in between are coalesced, keeping only the latest.
 */
export class ProgressThrottle {
  private readonly lastSentAt = new Map<string, number>();

  private readonly pending = new Map<string, PendingProgress>();

  constructor(private readonly intervalMs = 3000) {}

  /** Returns `text` when it may be sent now, or null when it is buffered. */
  offer(taskId: string, text: string, now: number): string | null {
    const last = this.lastSentAt.get(taskId);
    if (last === undefined || now - last >= this.intervalMs) {
      this.lastSentAt.set(taskId, now);
      this.pending.delete(taskId);
      return text;
    }

    this.pending.set(taskId, { text, dueAt: last + this.intervalMs });
    return null;
  }

  /** Removes and returns the buffered updates whose interval has elapsed. */
  takeDue(now: number): { taskId: string; text: string }[] {
    const due: { taskId: string; text: string }[] = [];
    for (const [taskId, pending] of this.pending) {
      if (pending.dueAt <= now) {
        this.pending.delete(taskId);
        this.lastSentAt.set(taskId, now);
        due.push({ taskId, text: pending.text });
      }
    }
    return due;
  }

  /** When the buffered update for `taskId` becomes due, if any. */
  dueAt(taskId: string): number | null {
    return this.pending.get(taskId)?.dueAt ?? null;
  }

  /** Forgets a task's timing and any buffered update. */
  drop(taskId: string): void {
    this.pending.delete(taskId);
    this.lastSentAt.delete(taskId);
  }
}
