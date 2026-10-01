import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpSink } from "../src/core";

// Real HTTP, real timers: the response table of the contract's section 5,
// "Outcomes and retries". Only an outcome in the body ends a send.

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
let server: http.Server | null = null;

async function serve(handler: Handler): Promise<string> {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/runs`;
}

afterEach(async () => {
  const s = server;
  server = null;
  if (!s) return;
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
});

const reply = (status: number, body?: string, type = "application/json"): Handler => (_req, res) => {
  res.writeHead(status, body === undefined ? {} : { "content-type": type });
  res.end(body);
};

describe("createHttpSink", () => {
  const cases: [string, Handler, string][] = [
    ["R1: 200 accepted", reply(200, '{"outcome":"accepted"}'), "accepted"],
    ["R2: 200 ignored", reply(200, '{"outcome":"ignored"}'), "ignored"],
    ["R3: 400 rejected", reply(400, '{"outcome":"rejected","reason":"too large"}'), "rejected"],
    ["R4: 401, no body", reply(401), "transient"],
    ["R5: 413, a body with no outcome", reply(413, "Payload Too Large", "text/plain"), "transient"],
    ["R6: 503, no body", reply(503), "transient"],
    ["R7: 200, no body", reply(200), "transient"],
    ["404 from a gateway", reply(404, '{"error":"not found"}'), "transient"],
    ["200 with an empty object", reply(200, "{}"), "transient"],
    ["200 with an unknown outcome", reply(200, '{"outcome":"stored"}'), "transient"],
    ["R8: the connection is dropped", (req) => req.socket.destroy(), "transient"],
  ];

  it.each(cases.map(([name, handler, expected]) => ({ name, handler, expected })))("$name -> $expected", async ({ handler, expected }) => {
    const url = await serve(handler);
    const result = await createHttpSink({ url }).send({ hello: "world" });
    expect(result.outcome).toBe(expected);
  });

  it("keeps the rejection reason", async () => {
    const url = await serve(reply(400, '{"outcome":"rejected","reason":"schema"}'));
    expect(await createHttpSink({ url }).send({})).toEqual({ outcome: "rejected", reason: "schema" });
  });

  it("R8: a server that never answers is transient after the timeout", async () => {
    const url = await serve(() => {});
    const started = Date.now();
    const result = await createHttpSink({ url, timeoutMs: 150 }).send({});
    expect(result.outcome).toBe("transient");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("an unreachable host is transient, not a throw", async () => {
    const result = await createHttpSink({ url: "http://127.0.0.1:9/never", timeoutMs: 1000 }).send({});
    expect(result.outcome).toBe("transient");
  });

  it("POSTs the payload as JSON with the host's headers, static or async", async () => {
    const seen: { method?: string; type?: string; auth?: string; body: string }[] = [];
    const url = await serve((req, res, body) => {
      seen.push({ method: req.method, type: req.headers["content-type"], auth: req.headers.authorization, body });
      reply(200, '{"outcome":"accepted"}')(req, res, body);
    });
    await createHttpSink({ url, headers: { authorization: "Bearer a" } }).send({ n: 1 });
    await createHttpSink({ url, headers: async () => ({ authorization: "Bearer b" }) }).send({ n: 2 });
    expect(seen).toEqual([
      { method: "POST", type: "application/json", auth: "Bearer a", body: '{"n":1}' },
      { method: "POST", type: "application/json", auth: "Bearer b", body: '{"n":2}' },
    ]);
  });

  it("a headers function that throws is transient, not a throw", async () => {
    const url = await serve(reply(200, '{"outcome":"accepted"}'));
    const sink = createHttpSink({ url, headers: () => { throw new Error("no token"); } });
    expect((await sink.send({})).outcome).toBe("transient");
  });
});
