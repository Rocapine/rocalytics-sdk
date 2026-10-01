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

export interface SerialStore<T> {
  /** Reads the value, after every write queued before it. Null when absent or unreadable. */
  load(): Promise<T | null>;
  /** Queues a write (null removes the key). Never throws; failures go to `onError`. */
  save(value: T | null): void;
  /** Resolves once every queued operation has finished. */
  idle(): Promise<void>;
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
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <R>(op: () => R | Promise<R>, fallback: R): Promise<R> => {
    const next = chain.then(op).catch((e) => {
      onError(e);
      return fallback;
    });
    chain = next;
    return next;
  };
  return {
    load: () =>
      enqueue(async () => {
        const raw = await storage.getItem(key);
        return raw == null ? null : (JSON.parse(raw) as T);
      }, null),
    save: (value) =>
      void enqueue(async () => {
        if (value === null) await storage.removeItem(key);
        else await storage.setItem(key, JSON.stringify(value));
      }, undefined),
    idle: () => enqueue(() => undefined, undefined),
  };
}
