/** Follow local panel geometry only while this viewer owns the shared browser. */
import { useEffect, useRef } from "react";

interface FillViewportOptions {
  identity: string;
  enabled: boolean;
  canResize: boolean;
  target: { width: number; height: number } | null;
  viewport: { width: number; height: number } | null;
  apply(): void;
}

/**
 * Coalesce layout changes and cancel scheduled work on authority, scope, or mode
 * changes. Unsupported sizes pause following; RPC failures are handled by the
 * caller, which disables the mode rather than retrying indefinitely.
 */
export function useBrowserFillViewport(options: FillViewportOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const width = options.target?.width;
  const height = options.target?.height;
  const viewportWidth = options.viewport?.width;
  const viewportHeight = options.viewport?.height;

  useEffect(() => {
    if (
      !options.enabled ||
      !options.canResize ||
      width === undefined ||
      height === undefined ||
      (width === viewportWidth && height === viewportHeight)
    ) {
      return;
    }

    const identity = options.identity;
    const timer = setTimeout(() => {
      // Recheck render-time authority even if effect cleanup has not run yet.
      const current = latest.current;
      if (
        current.identity === identity &&
        current.enabled &&
        current.canResize &&
        current.target?.width === width &&
        current.target?.height === height &&
        (current.viewport?.width !== width || current.viewport?.height !== height)
      ) {
        current.apply();
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [
    options.identity,
    options.enabled,
    options.canResize,
    width,
    height,
    viewportWidth,
    viewportHeight,
  ]);
}
