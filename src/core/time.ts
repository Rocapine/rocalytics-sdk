/** A source of the current time, in milliseconds since the epoch. Injected so tests can fix it. */
export interface Clock {
  now(): number;
}

/** The two timer functions the core uses. Injected so tests can drive time. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = { now: () => Date.now() };

export const systemTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * A UTC timestamp with exactly three fractional digits and a `Z`, e.g.
 * `2026-01-10T09:00:00.000Z`: the only timestamp form the contract accepts.
 * `toISOString` produces exactly that for every year from 0 to 9999.
 */
export function toTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}
