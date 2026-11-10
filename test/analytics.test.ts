import { describe, expect, it } from "vitest";
import { createAnalytics, ROCALYTICS_INGEST_URL, type AnalyticsConfig, type EventBatch } from "../src/analytics";
import { memoryStorage } from "../src/core";
import { flushMicrotasks, ManualTime, MemorySink } from "./fakes";

const setup = (over: Partial<AnalyticsConfig> = {}) => {
  const time = new ManualTime();
  const sink = new MemorySink<EventBatch>();
  let n = 0;
  const a = createAnalytics({
    appId: "com.rocapine.fitness-360",
    platform: "ios",
    sink,
    clock: time.clock,
    timers: time.timers,
    uuid: () => `evt-${String(++n).padStart(8, "0")}`,
    context: { appVersion: "2.4.0", osVersion: "18.1", locale: "fr-FR" },
    onDiagnostic: () => undefined,
    ...over,
  });
  return { a, time, sink };
};

describe("analytics", () => {
  it("batches at flushAt and maps the wire format", async () => {
    const { a, sink, time } = setup({ flushAt: 2, rocaId: () => "roca-1" });
    a.setUserId("user-9");
    a.track("workout_started", { workout: "abs" });
    expect(sink.received).toHaveLength(0);
    a.track("workout_done");
    await flushMicrotasks();
    expect(sink.received).toHaveLength(1);
    const b = sink.last!;
    expect(b).toMatchObject({ app_id: "com.rocapine.fitness-360", platform: "ios", sent_at: time.clock.now() });
    expect(b.sdk).toMatch(/^rocalytics-sdk\//);
    expect(b.events.map((e) => e.name)).toEqual(["workout_started", "workout_done"]);
    expect(b.events[0]).toMatchObject({
      event_id: "evt-00000001", roca_id: "roca-1", user_id: "user-9", app_version: "2.4.0",
      os_version: "18.1", locale: "fr-FR", properties: { workout: "abs" }, time: time.clock.now(),
    });
  });

  it("sends what is queued after flushIntervalMs", async () => {
    const { a, sink, time } = setup({ flushIntervalMs: 15_000 });
    a.track("app_open");
    await time.advance(14_999);
    expect(sink.received).toHaveLength(0);
    await time.advance(1);
    expect(sink.received).toHaveLength(1);
  });

  it("keeps events tracked before roca_id resolves and attaches it at send", async () => {
    let roca: string | null = null;
    const { a, sink } = setup({ rocaId: () => roca });
    a.track("onboarding_step_viewed");
    roca = "roca-late";
    await a.flush();
    expect(sink.last!.events[0].roca_id).toBe("roca-late");
  });

  it("retries a transient failure with the same event ids, then removes them", async () => {
    const { a, sink, time } = setup();
    sink.respond = (_, attempt) => (attempt === 1 ? { outcome: "transient" } : { outcome: "accepted" });
    a.track("x");
    await a.flush();
    expect(sink.received).toHaveLength(1);
    await time.advance(1000);
    expect(sink.received).toHaveLength(2);
    expect(sink.received[1].events[0].event_id).toBe(sink.received[0].events[0].event_id);
    await a.flush();
    expect(sink.received).toHaveLength(2); // nothing left
  });

  it("drops a rejected batch instead of retrying it", async () => {
    const diags: string[] = [];
    const { a, sink, time } = setup({ onDiagnostic: (d) => diags.push(d.code) });
    sink.respond = () => ({ outcome: "rejected", reason: "unknown app_id" });
    a.track("x");
    await a.flush();
    await time.advance(120_000);
    expect(sink.received).toHaveLength(1);
    expect(diags).toContain("rejected");
  });

  it("starts a new session after 5 minutes of inactivity", async () => {
    const { a, sink, time } = setup();
    a.track("a");
    const first = time.clock.now();
    await time.advance(4 * 60_000);
    a.track("b");
    await time.advance(5 * 60_000 + 1);
    a.track("c");
    await a.flush();
    const ids = sink.received.flatMap((b) => b.events.map((e) => e.session_id));
    expect(ids[0]).toBe(first);
    expect(ids[1]).toBe(first);
    expect(ids[2]).toBe(time.clock.now());
  });

  it("identify queues a $identify event with user_properties; reset clears the user", async () => {
    const { a, sink } = setup();
    a.setUserId("u1");
    a.identify({ plan: "pro" });
    a.reset();
    a.track("after_logout");
    await a.flush();
    const [id, after] = sink.last!.events;
    expect(id).toMatchObject({ name: "$identify", user_id: "u1", user_properties: { plan: "pro" }, properties: {} });
    expect(after.user_id).toBeNull();
    expect(after).not.toHaveProperty("user_properties");
  });

  it("caps the offline queue by dropping the oldest", async () => {
    const { a, sink } = setup({ flushAt: 3, maxQueue: 3 });
    sink.respond = () => ({ outcome: "transient" });
    for (const n of ["1", "2", "3", "4", "5"]) a.track(n);
    sink.respond = () => ({ outcome: "accepted" });
    await flushMicrotasks();
    await a.flush();
    expect(sink.last!.events.map((e) => e.name)).toEqual(["3", "4", "5"]);
  });

  it("persists unsent events, user id and session across restarts", async () => {
    const storage = memoryStorage();
    const first = setup({ storage, sink: { send: () => ({ outcome: "transient" }) } });
    first.a.setUserId("u1");
    first.a.track("before_kill");
    await first.a.idle();
    first.a.dispose();

    const { a, sink } = setup({ storage });
    a.track("after_restart");
    await a.flush();
    const events = sink.last!.events;
    expect(events.map((e) => e.name)).toEqual(["before_kill", "after_restart"]);
    expect(events[1].user_id).toBe("u1");
  });

  it("coalesces storage writes: a burst of tracks is not one full-queue write each", async () => {
    const inner = memoryStorage();
    let writes = 0;
    const storage = { ...inner, setItem: (k: string, v: string) => (writes++, inner.setItem(k, v)) };
    const { a } = setup({ storage, sink: { send: () => ({ outcome: "transient" }) } });
    for (let i = 0; i < 100; i++) a.track(`e${i}`);
    await a.idle();
    expect(writes).toBeLessThanOrEqual(2);
    a.dispose();

    const { a: b, sink } = setup({ storage });
    await b.flush();
    expect(sink.last!.events).toHaveLength(100);
  });

  it("continues the stored session for events tracked before storage loads", async () => {
    const storage = memoryStorage();
    const first = setup({ storage, sink: { send: () => ({ outcome: "transient" }) } });
    first.a.track("before_kill");
    const session = first.time.clock.now();
    await first.a.idle();
    first.a.dispose();

    await first.time.advance(36_000);
    const { a, sink } = setup({ storage, clock: first.time.clock, timers: first.time.timers });
    a.track("app_open"); // before the stored state has loaded
    await a.flush();
    expect(sink.last!.events.map((e) => e.session_id)).toEqual([session, session]);
  });

  it("starts a new session after a relaunch past the timeout", async () => {
    const storage = memoryStorage();
    const first = setup({ storage, sink: { send: () => ({ outcome: "transient" }) } });
    first.a.track("before_kill");
    const session = first.time.clock.now();
    await first.a.idle();
    first.a.dispose();

    await first.time.advance(5 * 60_000 + 1);
    const { a, sink } = setup({ storage, clock: first.time.clock, timers: first.time.timers });
    a.track("app_open");
    await a.flush();
    expect(sink.last!.events.map((e) => e.session_id)).toEqual([session, first.time.clock.now()]);
  });

  it("mints event ids from an injected getRandomValues", async () => {
    let calls = 0;
    const { a, sink } = setup({
      uuid: undefined,
      getRandomValues: (bytes) => {
        calls++;
        return bytes.fill(0xab);
      },
    });
    a.track("x");
    await a.flush();
    expect(calls).toBe(1);
    expect(sink.last!.events[0].event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-abababababab$/);
  });

  it("refuses bad names and never throws", () => {
    const diags: string[] = [];
    const { a } = setup({ onDiagnostic: (d) => diags.push(d.code), context: () => { throw new Error("boom"); } });
    expect(() => a.track("")).not.toThrow();
    expect(() => a.track("x".repeat(129))).not.toThrow();
    expect(() => a.track("ok")).not.toThrow();
    expect(diags.filter((c) => c === "invalid-name")).toHaveLength(2);
  });
});

describe("analytics restart ordering", () => {
  it("a setUserId(null) before the stored state loads wins over the stored user", async () => {
    const storage = memoryStorage();
    const first = setup({ storage, sink: { send: () => ({ outcome: "transient" }) } });
    first.a.setUserId("u1");
    first.a.track("x");
    await first.a.idle();
    first.a.dispose();
    const { a, sink } = setup({ storage });
    a.reset();
    a.track("after_logout");
    await a.flush();
    const events = sink.last!.events;
    expect(events.find((e) => e.name === "after_logout")!.user_id).toBeNull();
  });
});

describe("analytics endpoint", () => {
  it("defaults to the warehouse ingest", async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => { calls.push(url); return { ok: true, status: 200, text: async () => '{"outcome":"accepted"}' }; };
    const g = globalThis as { fetch?: unknown };
    const prev = g.fetch;
    g.fetch = fetch;
    try {
      const a = createAnalytics({ appId: "x", platform: "ios", onDiagnostic: () => undefined });
      a.track("e");
      await a.flush();
      a.dispose();
    } finally {
      g.fetch = prev;
    }
    expect(calls).toEqual([ROCALYTICS_INGEST_URL]);
    expect(ROCALYTICS_INGEST_URL).toBe("https://ingest.rocapi.ne/v1/batch");
  });
});
