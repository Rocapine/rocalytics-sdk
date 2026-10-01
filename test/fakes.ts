// Deterministic stand-ins for the clock, the timers and the sink. Tests drive
// time explicitly with `await time.advance(ms)`, which runs due timers in order
// and lets pending promises settle in between.
import type { Sink, SinkResult } from "../src/core";

export const flushMicrotasks = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

export class ManualTime {
  private current: number;
  private nextId = 1;
  private queue: { id: number; at: number; fn: () => void }[] = [];

  constructor(start = Date.parse("2026-01-10T08:00:00.000Z")) {
    this.current = start;
  }

  readonly clock = { now: () => this.current };
  readonly timers = {
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = this.nextId++;
      this.queue.push({ id, at: this.current + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      this.queue = this.queue.filter((t) => t.id !== handle);
    },
  };

  get pendingTimers() {
    return this.queue.length;
  }

  /** Moves the clock forward, firing every timer that comes due, in order. */
  async advance(ms: number) {
    const target = this.current + ms;
    await flushMicrotasks();
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.queue[0];
      if (!next || next.at > target) break;
      this.queue.shift();
      this.current = next.at;
      next.fn();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }
}

type Responder<T> = (body: T, attempt: number) => SinkResult | Promise<SinkResult> | unknown;

/** A sink that records every body it is handed and answers through `respond`. */
export class MemorySink<T = unknown> implements Sink<T> {
  readonly received: T[] = [];
  respond: Responder<T> = () => ({ outcome: "accepted" });

  send(body: T): Promise<SinkResult> {
    this.received.push(JSON.parse(JSON.stringify(body)));
    return Promise.resolve(this.respond(body, this.received.length) as SinkResult);
  }

  get last(): T | undefined {
    return this.received[this.received.length - 1];
  }
}
