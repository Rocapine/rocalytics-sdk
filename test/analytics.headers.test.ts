import { afterEach, describe, expect, it } from "vitest";
import { createAnalytics, type EventBatch } from "../src/analytics";
import { createHttpSink } from "../src/core";
import { memoryStorage } from "../src/core";
import { MemorySink } from "./fakes";

type Call = { url: string; init: { headers: Record<string, string>; body: string } };
const g = globalThis as { fetch?: unknown };
const realFetch = g.fetch;
afterEach(() => {
  g.fetch = realFetch;
});

function stubFetch(): Call[] {
  const calls: Call[] = [];
  g.fetch = async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    return { text: async () => '{"outcome":"accepted"}' };
  };
  return calls;
}

const make = (headers?: (b: EventBatch) => Record<string, string> | Promise<Record<string, string>>, extra = {}) =>
  createAnalytics({
    appId: "com.a",
    platform: "ios",
    storage: memoryStorage(),
    rocaId: () => "r1",
    headers,
    onDiagnostic: () => undefined,
    ...extra,
  });

describe("analytics headers", () => {
  it("the batch POST carries the headers the function returns for that batch", async () => {
    const calls = stubFetch();
    const seen: EventBatch[] = [];
    const a = make((batch) => {
      seen.push(batch);
      return { Authorization: "Bearer t" };
    });
    a.track("opened");
    await a.flush();
    a.dispose();
    expect(calls[0].init.headers.Authorization).toBe("Bearer t");
    expect(seen[0].events[0].roca_id).toBe("r1");
  });

  it("headers returning {} sends no Authorization", async () => {
    const calls = stubFetch();
    const a = make(async () => ({}));
    a.track("opened");
    await a.flush();
    a.dispose();
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it("headers throwing or rejecting still sends the batch, without them", async () => {
    for (const fn of [
      () => {
        throw new Error("boom");
      },
      () => Promise.reject(new Error("boom")),
    ]) {
      const calls = stubFetch();
      const a = make(fn);
      a.track("opened");
      await a.flush();
      a.dispose();
      expect(calls).toHaveLength(1);
      expect(calls[0].init.headers.Authorization).toBeUndefined();
      expect(calls[0].init.headers["content-type"]).toBe("application/json");
    }
  });

  it("with sink given, headers is ignored", async () => {
    const calls = stubFetch();
    let called = false;
    const sink = new MemorySink<EventBatch>();
    const a = make(() => {
      called = true;
      return { Authorization: "Bearer t" };
    }, { sink });
    a.track("opened");
    await a.flush();
    a.dispose();
    expect(called).toBe(false);
    expect(sink.received).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });
});

describe("createHttpSink headers", () => {
  const run = async (headers: Parameters<typeof createHttpSink>[0]["headers"], payload: unknown = { a: 1 }) => {
    const calls: Call[] = [];
    const sink = createHttpSink({
      url: "http://x/y",
      headers,
      fetch: async (url, init) => {
        calls.push({ url, init: init as Call["init"] });
        return { text: async () => '{"outcome":"accepted"}' };
      },
    });
    const result = await sink.send(payload);
    return { calls, result };
  };

  it("a zero-argument function and a plain object still work", async () => {
    expect((await run(() => ({ "x-a": "1" }))).calls[0].init.headers["x-a"]).toBe("1");
    expect((await run({ "x-b": "2" })).calls[0].init.headers["x-b"]).toBe("2");
  });

  it("a function receives the payload of each send", async () => {
    const seen: unknown[] = [];
    const { calls, result } = await run((p) => {
      seen.push(p);
      return { "x-c": "3" };
    }, { n: 7 });
    expect(seen).toEqual([{ n: 7 }]);
    expect(calls[0].init.headers["x-c"]).toBe("3");
    expect(result.outcome).toBe("accepted");
  });

  it("a throwing function is still a transient failure", async () => {
    const { calls, result } = await run(() => {
      throw new Error("no");
    });
    expect(calls).toHaveLength(0);
    expect(result.outcome).toBe("transient");
  });
});
