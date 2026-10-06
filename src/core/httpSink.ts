import { normalizeResult, type Sink, type SinkResult } from "./sink";

type Headers = Record<string, string>;

export interface HttpSinkOptions {
  /** The collector endpoint. Each payload is POSTed to it as JSON. */
  url: string;
  /** Extra request headers, such as an authorization token. A function is called for every send. */
  headers?: Headers | (() => Headers | Promise<Headers>);
  /** Defaults to the global `fetch`. */
  fetch?: (url: string, init: { method: string; headers: Headers; body: string; signal?: unknown }) => Promise<{
    text(): Promise<string>;
  }>;
  /** Gives up on a request after this long; the send is then transient. Default 15,000 ms. */
  timeoutMs?: number;
}

/**
 * A sink that POSTs each payload to an HTTP collector.
 *
 * The outcome comes from the response BODY only: `{"outcome": "accepted" |
 * "ignored" | "rejected"}`. The status code is not read, because a proxy or
 * gateway can answer 401, 404 or 413 without having looked at the payload, so
 * any response without an outcome, and no response at all, is transient.
 * It never throws.
 *
 * Its `destination` is `url`, unless a `fetch` is passed: that one may never
 * reach `url` (a test double), so the sink then has none.
 */
export function createHttpSink(options: HttpSinkOptions): Sink<unknown> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return {
    ...(options.fetch ? {} : { destination: options.url }),
    async send(payload): Promise<SinkResult> {
      const doFetch = options.fetch ?? (globalThis.fetch as unknown as HttpSinkOptions["fetch"]);
      if (!doFetch) return { outcome: "transient", reason: "no fetch available" };
      const Abort = (globalThis as { AbortController?: new () => { signal: unknown; abort(): void } }).AbortController;
      const controller = Abort ? new Abort() : null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const extra = typeof options.headers === "function" ? await options.headers() : options.headers;
        const request = doFetch(options.url, {
          method: "POST",
          headers: { ...extra, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller?.signal,
        }).then((res) => res.text());
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller?.abort();
            reject(new Error("timeout"));
          }, timeoutMs);
        });
        const text = await Promise.race([request, timeout]);
        let body: unknown = undefined;
        try {
          body = JSON.parse(text);
        } catch {
          // Not JSON: no outcome, so transient.
        }
        return normalizeResult(body);
      } catch (error) {
        return { outcome: "transient", reason: String(error) };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
