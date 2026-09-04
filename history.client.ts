import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "./rpc.client";

/**
 * Bounded ring buffers for the two sparklines.
 *
 * Sixty seconds at a two-second poll is 30 samples. The buffer is keyed on the
 * snapshot timestamp so a refetch that returns the cached server sample does
 * not double-count, and a null CPU (first sample) is stored as a gap rather
 * than a zero so the chart does not lie about a quiet machine.
 */

export const HISTORY_SECONDS = 60;
export const POLL_INTERVAL_MS = 2_000;
export const HISTORY_LENGTH = HISTORY_SECONDS / (POLL_INTERVAL_MS / 1000);

export interface HistorySample {
  at: string;
  cpu: number | null;
  memory: number | null;
}

export interface History {
  samples: HistorySample[];
}

export const EMPTY_HISTORY: History = { samples: [] };

export function sampleFromSnapshot(snapshot: Snapshot): HistorySample {
  const { cpu, memory } = snapshot.system;
  const memoryPercent = memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : null;
  return { at: snapshot.timestamp, cpu: cpu.percent, memory: memoryPercent };
}

export function pushSample(history: History, sample: HistorySample, max = HISTORY_LENGTH): History {
  const last = history.samples[history.samples.length - 1];
  if (last && last.at === sample.at) return history;
  const samples = [...history.samples, sample];
  return { samples: samples.length > max ? samples.slice(samples.length - max) : samples };
}

/** Values in chart order, oldest first, padded on the left so the chart never "grows in". */
export function series(history: History, pick: (sample: HistorySample) => number | null, length = HISTORY_LENGTH): Array<number | null> {
  const values = history.samples.map(pick);
  if (values.length >= length) return values.slice(values.length - length);
  return [...new Array<null>(length - values.length).fill(null), ...values];
}

export function useHistory(snapshot: Snapshot | undefined): History {
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const lastAt = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshot || snapshot.timestamp === lastAt.current) return;
    lastAt.current = snapshot.timestamp;
    setHistory((previous) => pushSample(previous, sampleFromSnapshot(snapshot)));
  }, [snapshot]);
  return history;
}

/**
 * Seconds since the last successful sample, ticking once a second so the
 * "stale" state can appear even when nothing else re-renders.
 */
export function useAge(updatedAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  if (!updatedAt) return null;
  return Math.max(0, Math.round((now - updatedAt) / 1000));
}

/** A value only becomes visible after it has stopped changing for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
