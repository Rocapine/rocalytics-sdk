import type { Clock } from "./time";

const hex = (bytes: Uint8Array, from: number, to: number) => {
  let out = "";
  for (let i = from; i < to; i++) out += (bytes[i] + 0x100).toString(16).slice(1);
  return out;
};

/**
 * A lowercase UUIDv7 (RFC 9562): 48 bits of millisecond time, then random
 * bits. It sorts by creation time, which is why the contract recommends it.
 * `random` must hold at least 16 bytes; only the bits after the time are used.
 */
export function uuidv7(nowMs: number, random: Uint8Array): string {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = random[i] ?? 0;
  let t = Math.max(0, Math.floor(nowMs));
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = 0x70 | (b[6] & 0x0f); // version 7
  b[8] = 0x80 | (b[8] & 0x3f); // variant 10xx
  return `${hex(b, 0, 4)}-${hex(b, 4, 6)}-${hex(b, 6, 8)}-${hex(b, 8, 10)}-${hex(b, 10, 16)}`;
}

/** Fills `bytes` with random values, like `crypto.getRandomValues` (expo-crypto's `getRandomValues` fits). */
export type GetRandomValues = (bytes: Uint8Array) => unknown;

/**
 * 16 random bytes: from `getRandomValues` when given, else from the runtime's
 * `crypto.getRandomValues`, else from `Math.random`. Hermes has no `crypto`
 * global (and importing expo-crypto does not add one), so on React Native pass
 * expo-crypto's `getRandomValues` to avoid the `Math.random` fallback. A source
 * that throws falls through to the next one.
 */
export function randomBytes16(getRandomValues?: GetRandomValues): Uint8Array {
  const out = new Uint8Array(16);
  if (getRandomValues) {
    try {
      getRandomValues(out);
      return out;
    } catch {
      // fall through
    }
  }
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < 16; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** The default id minter: UUIDv7 from the injected clock and random source. */
export function createUuid(clock: Clock, getRandomValues?: GetRandomValues): () => string {
  return () => uuidv7(clock.now(), randomBytes16(getRandomValues));
}
