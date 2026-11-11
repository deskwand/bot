/** Timing source for the butler. Injectable so tests can advance time. */
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
