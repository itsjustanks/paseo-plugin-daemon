/**
 * Records bounded, redacted RPC failures in the plugin process so Paseo retains
 * them. Never log URLs, input text, credentials, tokens or raw remote messages.
 * Repeated failures in one operation/category emit at most once each 30 seconds.
 */
const REPORT_INTERVAL_MS = 30_000;
const MAX_DIAGNOSTIC_KEYS = 64;
const SAFE_CDP_TIMEOUT_METHODS = new Set([
  "Page.enable",
  "Page.getLayoutMetrics",
  "Page.captureScreenshot",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.addBinding",
  "Target.createTarget",
  "Target.attachToTarget",
  "Target.getTargets",
  "Target.closeTarget",
  "Performance.enable",
  "Performance.getMetrics",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Emulation.setUserAgentOverride",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.dispatchTouchEvent",
  "Input.insertText",
]);

export interface BrowserFailureDiagnostic {
  operation: string;
  category: "timeout" | "stale-frame" | "expired-authority" | "capacity" | "connection" | "other";
  cdpMethod?: string;
  durationMs: number;
}

/** Return only fixed categories and a fixed allowlisted CDP method from an error. */
export function classifyBrowserFailure(
  error: unknown,
): Omit<BrowserFailureDiagnostic, "operation" | "durationMs"> {
  const message = error instanceof Error ? error.message : "";
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "RUNTIME_BUSY") return { category: "capacity" };
  if (code === "BRIDGE_FENCED") return { category: "expired-authority" };
  const candidateMethod =
    /\b((?:Page|Runtime|Target|Input|Emulation|Performance|Browser)\.[A-Za-z]{1,64}) timed out\b/.exec(
      message,
    )?.[1];
  const method =
    candidateMethod && SAFE_CDP_TIMEOUT_METHODS.has(candidateMethod) ? candidateMethod : undefined;
  if (/timed out|timeout/i.test(message))
    return { category: "timeout", ...(method ? { cdpMethod: method } : {}) };
  if (/frame is stale/i.test(message)) return { category: "stale-frame" };
  if (/token is invalid or expired|lease is invalid or expired|BRIDGE_FENCED/.test(message))
    return { category: "expired-authority" };
  if (/RUNTIME_BUSY|capacity|too many/i.test(message)) return { category: "capacity" };
  if (/connection closed|unavailable|disconnected/i.test(message))
    return { category: "connection" };
  return { category: "other" };
}

/** Wrap one operation, preserving its original error and success result exactly. */
export function createBrowserOperationDiagnostics(
  options: { now?: () => number; report?: (diagnostic: BrowserFailureDiagnostic) => void } = {},
) {
  const now = options.now ?? Date.now;
  const report =
    options.report ??
    ((diagnostic) => console.warn("[hosts-browser] operation failed", diagnostic));
  const lastReported = new Map<string, number>();
  return async function diagnose<T>(operation: string, perform: () => Promise<T>): Promise<T> {
    const startedAt = now();
    try {
      return await perform();
    } catch (error) {
      const details = classifyBrowserFailure(error);
      // Operations come from internal method names, not client-provided strings.
      const safeOperation = /^[a-z][a-z.-]{0,63}$/.test(operation) ? operation : "unknown";
      const key = `${safeOperation}:${details.category}`;
      const previous = lastReported.get(key);
      const observedAt = now();
      if (previous === undefined || observedAt - previous >= REPORT_INTERVAL_MS) {
        if (lastReported.size >= MAX_DIAGNOSTIC_KEYS) {
          const oldest = lastReported.keys().next().value;
          if (oldest !== undefined) lastReported.delete(oldest);
        }
        lastReported.set(key, observedAt);
        try {
          report({
            operation: safeOperation,
            ...details,
            durationMs: Math.max(0, observedAt - startedAt),
          });
        } catch {
          // Observability must never replace the original operation failure.
        }
      }
      throw error;
    }
  };
}
