/** Debounced automatic detail adjustments, with no observer writes or failure retry loop. */
import { useEffect, useRef } from "react";
import type { CaptureDensity } from "../../shared/managed-browser/capture-density";

interface Options {
  identity: string;
  enabled: boolean;
  canChange: boolean;
  target: CaptureDensity | null;
  currentDensity: number;
  apply(density: CaptureDensity): void;
}

/** Cancel pending adjustments when scope, ownership, manual choice or geometry changes. */
export function useBrowserAutoCaptureDensity(options: Options): void {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!options.enabled || !options.canChange || options.target === null) return;
    if (options.target === options.currentDensity) return;
    const density = options.target;
    const identity = options.identity;
    const timer = setTimeout(() => {
      const current = latest.current;
      if (
        current.identity === identity &&
        current.enabled &&
        current.canChange &&
        current.target === density &&
        current.currentDensity !== density
      ) {
        current.apply(density);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [
    options.identity,
    options.enabled,
    options.canChange,
    options.target,
    options.currentDensity,
  ]);
}
