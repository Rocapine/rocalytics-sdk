import { describe, expect, it, vi } from "vitest";
import {
  codePointLength,
  createDelivery,
  memoryStorage,
  createSerialStore,
  toTimestamp,
  utf8ByteLength,
  uuidv7,
  createUuid,
  type SinkResult,
} from "../src/core";
import { ManualTime, MemorySink, flushMicrotasks } from "./fakes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

describe("utf8ByteLength", () => {
  it("agrees with Buffer.byteLength on ASCII, accents, CJK and astral characters", () => {
    for (const s of ["", "abc", "é", "日本語", "😀", "a😀é日", JSON.stringify({ v: "x y" })]) {
      expect(utf8ByteLength(s), s).toBe(Buffer.byteLength(s, "utf8"));
    }
  });

  it("counts a lone surrogate as the 3-byte replacement character, as an encoder would", () => {
    expect(utf8ByteLength("\ud800")).toBe(Buffer.byteLength("\ud800", "utf8"));
  });
});

describe("codePointLength", () => {
  it("counts code points, as JSON Schema's maxLength does", () => {
    expect(codePointLength("😀😀")).toBe(2);
    expect("😀😀".length).toBe(4);
  });
});

describe("toTimestamp", () => {
  it("always has exactly three fractional digits and a Z (D24)", () => {
    for (const ms of [0, Date.parse("2026-01-10T08:00:00Z"), Date.parse("2026-01-10T08:00:00.5Z"), 1_767_000_000_123]) {
      expect(toTimestamp(ms)).toMatch(TIMESTAMP);
    }
    expect(toTimestamp(Date.parse("2026-01-10T08:00:00Z"))).toBe("2026-01-10T08:00:00.000Z");
  });
});

describe("uuidv7", () => {
  it("is a lowercase UUID with version 7 and the RFC 9562 variant", () => {
    const id = uuidv7(Date.parse("2026-01-10T08:00:00.000Z"), new Uint8Array(16).fill(0xff));
    expect(id).toMatch(UUID);
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("encodes the millisecond time in its first 48 bits, so ids sort by time", () => {
    const t = Date.parse("2026-01-10T08:00:00.000Z");
    const id = uuidv7(t, new Uint8Array(16));
    expect(parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(t);
    expect(uuidv7(t, new Uint8Array(16).fill(0xff)) < uuidv7(t + 1, new Uint8Array(16))).toBe(true);
  });

  it("createUuid works with no crypto global, and gives distinct ids", () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", undefined);
    try {
      const mint = createUuid({ now: () => 1 });
      const ids = new Set(Array.from({ length: 100 }, mint));
      expect(ids.size).toBe(100);
      for (const id of ids) expect(id).toMatch(UUID);
    } finally {
      vi.stubGlobal("crypto", original);
    }
  });
});

describe("createSerialStore", () => {
  it("applies writes in order and reads back the last one", async () => {
    const storage = memoryStorage();
    const store = createSerialStore<{ n: number }>(storage, "k", () => {});
    store.save({ n: 1 });
    store.save({ n: 2 });
    expect(await store.load()).toEqual({ n: 2 });
    store.save(null);
    expect(await store.load()).toBeNull();
  });

  it("reports a failing or corrupt storage instead of throwing", async () => {
    const errors: unknown[] = [];
    const broken = {
      getItem: () => "{not json",
      setItem: () => Promise.reject(new Error("disk full")),
      removeItem: () => {},
    };
    const store = createSerialStore(broken, "k", (e) => errors.push(e));
    store.save({ a: 1 });
    expect(await store.load()).toBeNull();
    expect(errors.length).toBe(2);
  });
});

describe("createDelivery", () => {
  const setup = (respond?: MemorySink["respond"]) => {
    const time = new ManualTime();
    const sink = new MemorySink<{ seq: number; v?: string }>();
    if (respond) sink.respond = respond;
    const settled: { seq: number; outcome: string }[] = [];
    const delivery = createDelivery({
      sink,
      timers: time.timers,
      retry: { initialDelayMs: 1000, factor: 2, maxDelayMs: 4000 },
      attemptTimeoutMs: 30_000,
      onSettled: (item, result) => settled.push({ seq: item.seq, outcome: result.outcome }),
    });
    return { time, sink, delivery, settled };
  };

  it.each(["accepted", "ignored", "rejected"] as const)("drops a snapshot answered %s and never resends it", async (outcome) => {
    const { time, sink, delivery, settled } = setup(() => ({ outcome }));
    delivery.enqueue({ seq: 1, body: { seq: 1 } });
    await time.advance(60_000);
    expect(sink.received).toHaveLength(1);
    expect(settled).toEqual([{ seq: 1, outcome }]);
    expect(delivery.pending()).toBeNull();
    delivery.enqueue({ seq: 1, body: { seq: 1 } }); // the same snapshot again
    await time.advance(60_000);
    expect(sink.received).toHaveLength(1);
  });

  const transient: [string, MemorySink["respond"]][] = [
    ["a thrown error", () => { throw new Error("offline"); }],
    ["a rejected promise", () => Promise.reject(new Error("offline"))],
    ["an explicit transient", () => ({ outcome: "transient" })],
    ["no result", () => undefined],
    ["an unknown outcome", () => ({ outcome: "maybe" })],
  ];
  it.each(transient)("retries %s with the same seq and body, backing off", async (_name, respond) => {
    let calls = 0;
    const { time, sink, delivery } = setup((b, n) => (++calls < 4 ? (respond as (b: unknown, n: number) => SinkResult)(b, n) : { outcome: "accepted" }));
    delivery.enqueue({ seq: 7, body: { seq: 7, v: "x" } });
    await time.advance(0);
    expect(sink.received).toHaveLength(1);
    await time.advance(999);
    expect(sink.received).toHaveLength(1); // first retry after 1000 ms
    await time.advance(1);
    expect(sink.received).toHaveLength(2);
    await time.advance(2000); // then 2000 ms
    expect(sink.received).toHaveLength(3);
    await time.advance(4000); // then 4000 ms (capped)
    expect(sink.received).toHaveLength(4);
    expect(new Set(sink.received.map((b) => JSON.stringify(b)))).toEqual(new Set([JSON.stringify({ seq: 7, v: "x" })]));
    expect(delivery.pending()).toBeNull();
  });

  it("caps the backoff", async () => {
    const { time, sink, delivery } = setup(() => ({ outcome: "transient" }));
    delivery.enqueue({ seq: 1, body: { seq: 1 } });
    await time.advance(0);
    await time.advance(1000 + 2000 + 4000);
    const before = sink.received.length;
    await time.advance(4000);
    expect(sink.received.length).toBe(before + 1);
  });

  it("a newer snapshot replaces an unsent older one: only the latest matters", async () => {
    const { time, sink, delivery } = setup(() => ({ outcome: "transient" }));
    delivery.enqueue({ seq: 1, body: { seq: 1 } });
    await time.advance(0);
    delivery.enqueue({ seq: 2, body: { seq: 2 } });
    delivery.enqueue({ seq: 3, body: { seq: 3 } });
    sink.respond = () => ({ outcome: "accepted" });
    await time.advance(1000);
    expect(sink.received.map((b) => b.seq)).toEqual([1, 3]);
    expect(delivery.pending()).toBeNull();
  });

  it("an older seq never replaces a newer pending one", () => {
    const { delivery } = setup(() => new Promise(() => {}));
    delivery.enqueue({ seq: 5, body: { seq: 5 } });
    delivery.enqueue({ seq: 4, body: { seq: 4 } });
    expect(delivery.pending()?.seq).toBe(5);
  });

  it("while one send is in flight, a newer snapshot waits, then goes out; the stale one is not retried", async () => {
    let release!: (r: SinkResult) => void;
    const { time, sink, delivery } = setup(() => new Promise<SinkResult>((r) => (release = r)));
    delivery.enqueue({ seq: 1, body: { seq: 1 } });
    await time.advance(0);
    delivery.enqueue({ seq: 2, body: { seq: 2 } });
    await time.advance(0);
    expect(sink.received).toHaveLength(1);
    sink.respond = () => ({ outcome: "accepted" });
    release({ outcome: "transient" });
    await time.advance(1000);
    expect(sink.received.map((b) => b.seq)).toEqual([1, 2]);
    await time.advance(60_000);
    expect(sink.received.map((b) => b.seq)).toEqual([1, 2]);
  });

  it("a send that never answers times out and counts as transient", async () => {
    const { time, sink, delivery } = setup(() => new Promise(() => {}));
    delivery.enqueue({ seq: 1, body: { seq: 1 } });
    await time.advance(30_000);
    sink.respond = () => ({ outcome: "accepted" });
    await time.advance(1000);
    expect(sink.received).toHaveLength(2);
    expect(delivery.pending()).toBeNull();
  });

  it("flush() sends now instead of waiting out the backoff", async () => {
    const { time, sink, delivery } = setup(() => ({ outcome: "transient" }));
    delivery.enqueue({ seq: 1, body: { seq: 1 } });
    await time.advance(0);
    delivery.flush();
    await flushMicrotasks();
    expect(sink.received).toHaveLength(2);
  });

  it("never throws into the caller, whatever the sink does", async () => {
    const time = new ManualTime();
    const delivery = createDelivery({
      sink: { send: () => { throw new Error("boom"); } },
      timers: time.timers,
    });
    expect(() => delivery.enqueue({ seq: 1, body: {} })).not.toThrow();
    expect(() => delivery.flush()).not.toThrow();
    await time.advance(10_000);
    expect(delivery.pending()?.seq).toBe(1); // kept, still to be retried
  });
});

describe("createDelivery: close()", () => {
  it("makes one last attempt for the pending snapshot, then schedules no retry", async () => {
    const time = new ManualTime();
    const sink = new MemorySink();
    sink.respond = () => ({ outcome: "transient" });
    const delivery = createDelivery({ sink, timers: time.timers, retry: { initialDelayMs: 1000 } });
    delivery.enqueue({ seq: 1, body: { seq: 1 } });
    await time.advance(0);
    expect(sink.received).toHaveLength(1);
    delivery.close();
    await time.advance(0);
    expect(sink.received).toHaveLength(2); // the backoff is skipped once
    await time.advance(60_000);
    expect(sink.received).toHaveLength(2);
    expect(time.pendingTimers).toBe(0);
    delivery.enqueue({ seq: 2, body: { seq: 2 } }); // a snapshot handed over after close still gets its one attempt
    await time.advance(0);
    expect(sink.received.map((b) => (b as { seq: number }).seq)).toEqual([1, 1, 2]);
    expect(delivery.pending()?.seq).toBe(2); // kept, never dropped
  });
});

describe("createSerialStore: read() and the shared queue", () => {
  it("tells a failed read from an unparseable value, and retries a failed read once", async () => {
    const ok = memoryStorage();
    ok.setItem("k", '{"a":1}');
    expect(await createSerialStore(ok, "k", () => {}).read()).toEqual({ status: "ok", value: { a: 1 } });
    const bad = memoryStorage();
    bad.setItem("k", "{nope");
    expect((await createSerialStore(bad, "k", () => {}).read()).status).toBe("invalid");
    let fails = 1;
    const flaky = { ...ok, getItem: (k: string) => (fails-- > 0 ? Promise.reject(new Error("x")) : ok.getItem(k)) };
    expect(await createSerialStore(flaky, "k", () => {}).read()).toEqual({ status: "ok", value: { a: 1 } });
    fails = 2;
    expect((await createSerialStore(flaky, "k", () => {}).read()).status).toBe("failed");
  });

  it("two stores on the same storage and key share one queue: a later store's read sees an earlier store's writes", async () => {
    const storage = memoryStorage();
    const slow = { ...storage, setItem: (k: string, v: string) => new Promise<void>((r) => setTimeout(() => { storage.setItem(k, v); r(); }, 5)) };
    const first = createSerialStore<{ n: number }>(slow, "k", () => {});
    first.save({ n: 1 });
    const second = createSerialStore<{ n: number }>(slow, "k", () => {});
    expect(await second.read()).toEqual({ status: "ok", value: { n: 1 } });
  });

  it("saveWith() computes the value when its turn comes, and skips the write on undefined", async () => {
    const storage = memoryStorage();
    const store = createSerialStore<{ n: number }>(storage, "k", () => {});
    let n = 1;
    const done = store.saveWith(() => ({ n }));
    n = 2;
    await done;
    expect(storage.dump().k).toBe('{"n":2}');
    await store.saveWith(() => undefined);
    expect(storage.dump().k).toBe('{"n":2}');
  });
});
