/**
 * A string key-value store. The shape matches `@react-native-async-storage/async-storage`
 * and `localStorage`, so either can be passed as is; this package depends on neither.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** An in-memory `KeyValueStorage`. Survives nothing; useful for tests and for opting out of persistence. */
export function memoryStorage(): KeyValueStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

/** What a read found: a value (or nothing stored), a value that is not JSON, or no answer from storage at all. */
export type ReadResult<T> =
  | { status: "ok"; value: T | null }
  | { status: "invalid"; error: unknown }
  | { status: "failed"; error: unknown };

export interface SerialStore<T> {
  /** Reads the value, after every write queued before it. Null when absent or unreadable. */
  load(): Promise<T | null>;
  /**
   * Reads the value, after every write queued before it, telling a value that
   * is not JSON (`invalid`) from storage that did not answer (`failed`). A
   * failed read is retried once, in the same turn, before it counts as failed.
   */
  read(): Promise<ReadResult<T>>;
  /** Queues a write (null removes the key). Never throws; failures go to `onError`. */
  save(value: T | null): void;
  /**
   * Queues a write whose value is computed when its turn comes, so it is the
   * latest one; `undefined` skips the write. Resolves once done. Never rejects.
   */
  saveWith(produce: () => T | null | undefined | Promise<T | null | undefined>): Promise<void>;
  /** Resolves once every queued operation has finished. */
  idle(): Promise<void>;
}

// One queue per storage object and key, shared by every store over them: a
// store created later (an app reconfiguring its tracker) reads only after the
// writes an earlier store already queued.
const queues = new WeakMap<object, Map<string, { chain: Promise<unknown> }>>();
function queueFor(storage: KeyValueStorage, key: string) {
  let byKey = queues.get(storage);
  if (!byKey) queues.set(storage, (byKey = new Map()));
  let q = byKey.get(key);
  if (!q) byKey.set(key, (q = { chain: Promise.resolve() }));
  return q;
}

/**
 * JSON values under one key, with every read and write applied in call order,
 * so an older write can never land after a newer one.
 */
export function createSerialStore<T>(
  storage: KeyValueStorage,
  key: string,
  onError: (error: unknown) => void,
): SerialStore<T> {
  const queue = queueFor(storage, key);
  const enqueue = <R>(op: () => R | Promise<R>, fallback: R): Promise<R> => {
    const next = queue.chain.then(op).catch((e) => {
      onError(e);
      return fallback;
    });
    queue.chain = next;
    return next;
  };
  const getRaw = async (): Promise<string | null> => {
    try {
      return await storage.getItem(key);
    } catch {
      return await storage.getItem(key); // one retry, still inside this turn of the queue
    }
  };
  const read = (): Promise<ReadResult<T>> =>
    enqueue<ReadResult<T>>(async () => {
      let raw: string | null;
      try {
        raw = await getRaw();
      } catch (error) {
        return { status: "failed", error };
      }
      if (raw == null) return { status: "ok", value: null };
      try {
        return { status: "ok", value: JSON.parse(raw) as T };
      } catch (error) {
        return { status: "invalid", error };
      }
    }, { status: "failed", error: undefined });
  const write = async (value: T | null) => {
    if (value === null) await storage.removeItem(key);
    else await storage.setItem(key, JSON.stringify(value));
  };
  return {
    load: () =>
      read().then((r) => {
        if (r.status === "ok") return r.value;
        onError(r.error);
        return null;
      }),
    read,
    save: (value) => void enqueue(() => write(value), undefined),
    saveWith: (produce) =>
      enqueue(async () => {
        const value = await produce();
        if (value !== undefined) await write(value);
      }, undefined),
    idle: () => enqueue(() => undefined, undefined),
  };
}
