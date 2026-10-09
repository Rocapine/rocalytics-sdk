/**
 * Something the SDK chose not to do, or could not do, reported instead of
 * thrown: tracking must never break the app it runs in.
 */
export interface Diagnostic {
  /** Stable machine-readable code, e.g. `unknown-step`, `rejected`, `truncated`. */
  code: string;
  message: string;
  runId?: string;
}

export type DiagnosticHandler = (diagnostic: Diagnostic) => void;

/** The default handler: a console warning, when a console exists. */
export const consoleDiagnostics: DiagnosticHandler = (d) => {
  const c = (globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console;
  c?.warn?.(`[rocalytics-sdk] ${d.code}: ${d.message}`);
};

/** Wraps a host handler so that a handler which throws cannot break the caller. */
export function safeDiagnostics(handler: DiagnosticHandler | undefined): DiagnosticHandler {
  const h = handler ?? consoleDiagnostics;
  return (d) => {
    try {
      h(d);
    } catch {
      // ignored on purpose
    }
  };
}
