import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { processPreview, OUTSIDE_PASEO_WARNING, type StopPlan } from "../shared/processes";
import { processStateWords } from "../shared/service-inventory";
import { StopSheet } from "./processes";
import { CancelButton, DestructiveButton } from "./feedback";
import { errorText, useCopy, useOnce, useSafeToast, Sheet } from "./feedback";
import { friendlyPath, pathWidth, truncateMiddle } from "../shared/paths";
import { redactSecrets } from "../shared/redaction";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation } from "@tanstack/react-query";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { processKey, useMonitorRpc, type Impact, type Process, type Snapshot } from "./rpc";
import { Button, Card, Facts, StatusPill, Tag, alpha, formatBytes, formatDuration, formatPercent, toneColor, useTokens, type Tone } from "./ui";

/**
 * The dev-server card and the process row with its stop controls, shared by
 * the Hosts screen's Dev servers tab and each workspace's Hosts tab. (The 0.9
 * Daemon Health view that also lived here is now the Processes tab.)
 */

/** Polls a graceful-stopped process may survive before Force Stop is offered. */
const FORCE_AFTER_POLLS = 3;
/** Pending stops older than this are dropped so a reused PID cannot inherit them. */
const PENDING_TTL_MS = 60_000;

function impactTone(impact: Impact): Tone {
  return impact === "pressure-driver" ? "danger" : impact === "high" ? "warning" : "neutral";
}

function impactLabel(impact: Impact): string {
  return impact === "pressure-driver" ? "Likely pressure driver" : impact === "high" ? "High" : impact === "idle" ? "Idle" : "Normal";
}

function stateTone(state: string): Tone {
  const lower = state.toLowerCase();
  if (lower.startsWith("z")) return "warning";
  if (lower.startsWith("r")) return "accent";
  return "neutral";
}

// ------------------------------------------------------------ pending stops

interface PendingStop {
  key: string;
  name: string;
  pid: number;
  startedAt: number;
  /** Polls in which the identity was still present after the graceful attempt. */
  survivedPolls: number;
}

/**
 * Tracks graceful stops so the UI can (a) show "stopping…" and (b) promote the
 * control to Force Stop after the process outlives several polls. The server
 * gate is the real guard; this just decides when to show the option.
 */
export function usePendingStops(snapshot: Snapshot | undefined) {
  const [pending, setPending] = useState<Record<string, PendingStop>>({});
  const lastAt = useRef<string | null>(null);

  useEffect(() => {
    if (!snapshot || snapshot.timestamp === lastAt.current) return;
    lastAt.current = snapshot.timestamp;
    const alive = new Set<string>();
    for (const process of snapshot.processes.items) alive.add(processKey(process));
    for (const process of snapshot.services) alive.add(processKey(process));
    const now = Date.now();
    setPending((previous) => {
      let changed = false;
      const next: Record<string, PendingStop> = {};
      for (const entry of Object.values(previous)) {
        if (now - entry.startedAt > PENDING_TTL_MS) {
          changed = true;
          continue;
        }
        if (alive.has(entry.key)) {
          next[entry.key] = { ...entry, survivedPolls: entry.survivedPolls + 1 };
          changed = true;
        } else {
          // Gone from the page; either exited or filtered out. Keep it one more
          // poll so a filtered-out row does not silently lose its state.
          if (entry.survivedPolls > 0) {
            changed = true;
            continue;
          }
          next[entry.key] = { ...entry, survivedPolls: 1 };
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [snapshot]);

  const mark = useCallback((process: Process) => {
    const key = processKey(process);
    setPending((previous) => ({ ...previous, [key]: { key, name: process.name, pid: process.pid, startedAt: Date.now(), survivedPolls: 0 } }));
  }, []);

  const clear = useCallback((key: string) => {
    setPending((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, []);

  return { pending, mark, clear };
}

export { errorText };

/**
 * Stop / force-stop mutations plus the row action bag. Shared by the host
 * surface and the workspace panel so both offer identical controls.
 */
export function useProcessActions({ theme, rpc, snapshot, pendingStops, refresh }: {
  theme: PluginTheme;
  rpc: ReturnType<typeof useMonitorRpc>;
  snapshot: Snapshot | undefined;
  pendingStops: ReturnType<typeof usePendingStops>;
  refresh: () => void;
}) {
  const toast = useSafeToast();
  const { pending, mark, clear } = pendingStops;
  const [forceTarget, setForceTarget] = useState<Process | null>(null);
  const [forcePlan, setForcePlan] = useState<StopPlan | null>(null);
  const [review, setReview] = useState<{ process: Process; plan: StopPlan } | null>(null);
  const preview = useRpc(processPreview);
  const previewLock = useRef(false);
  const ask = useMutation({
    mutationFn: async ({ process, force }: { process: Process; force: boolean }) => {
      if (!process.actionable || !process.actionToken) throw new Error(process.protectedReason ?? "This process cannot be stopped here.");
      // Keep the reviewed identity. A later snapshot must never swap in a new token.
      const frozen = { ...process };
      const plan = await preview({ tokens: [frozen.actionToken!] });
      return { process: frozen, plan, force };
    },
    onSuccess: ({ process, plan, force }) => {
      if (force) { setForcePlan(plan); setForceTarget(process); }
      else setReview({ process, plan });
    },
    onError: (error) => toast.error(errorText(error)),
    onSettled: () => { previewLock.current = false; },
  });
  const requestReview = (process: Process, force: boolean) => {
    if (previewLock.current || review || forceTarget) return;
    previewLock.current = true;
    ask.mutate({ process, force });
  };

  const stopMutation = useMutation({
    mutationFn: async (process: Process) => {
      if (!process.actionToken) throw new Error("This process cannot be stopped from Monitor.");
      return rpc.stop({ token: process.actionToken });
    },
    onSuccess: (result, process) => {
      setReview(null);
      if (result.status === "already-exited") {
        toast.show(`${process.name} (PID ${process.pid}) had already exited`, { variant: "success" });
      } else if (result.ok) {
        mark(process);
        toast.show(`Asked ${process.name} (PID ${process.pid}) to stop`, { variant: "info" });
      } else {
        toast.error(result.message || `Could not stop ${process.name}`);
      }
      refresh();
    },
    onError: (error) => { setReview(null); toast.error(errorText(error)); },
  });

  const forceMutation = useMutation({
    mutationFn: async (process: Process) => {
      if (!process.actionToken) throw new Error("This process cannot be stopped from Monitor.");
      return rpc.forceStop({ token: process.actionToken });
    },
    onSuccess: (result, process) => {
      setForceTarget(null);
      if (result.ok || result.status === "already-exited") {
        clear(processKey(process));
        toast.show(result.status === "already-exited" ? `${process.name} (PID ${process.pid}) had already exited` : `Force stopped ${process.name} (PID ${process.pid})`, { variant: "success" });
      } else if (result.status === "needs-graceful-first") {
        toast.show(result.message || `Try a graceful stop of ${process.name} first`, { variant: "warning" });
      } else {
        toast.error(result.message || `Could not force stop ${process.name}`);
      }
      refresh();
    },
    onError: (error) => {
      setForceTarget(null);
      toast.error(errorText(error));
    },
  });

  const actions: RowActions = {
    pending,
    onStop: (process) => requestReview(process, false),
    onForce: (process) => requestReview(process, true),
    stopping: stopMutation.isPending ? stopMutation.variables : ask.isPending ? ask.variables?.process : undefined,
  };
  return {
    actions, liveForceTarget: forceTarget, forcePlan, forceMutation,
    setForceTarget: (target: Process | null) => { setForceTarget(target); if (!target) setForcePlan(null); },
    stopReview: <StopSheet theme={theme} automaticForce={false} plan={review?.plan ?? null} busy={stopMutation.isPending} onCancel={() => setReview(null)} onConfirm={() => { if (review) stopMutation.mutate(review.process); }} />,
  };
}

// ---------------------------------------------------------------- overview

export interface RowActions {
  pending: Record<string, PendingStop>;
  onStop: (process: Process) => void;
  onForce: (process: Process) => void;
  stopping: Process | undefined;
}

/** One verified dev server. `footer` is where the Hosts views put their Open / link controls. */
export function ServiceCard({ process, actions, footer }: { process: Process; actions: RowActions; footer?: React.ReactNode }) {
  const t = useTokens();
  const isServer = process.classification.kind === "dev-server";
  return (
    <Card>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: t.space.sm, minWidth: 0 }}>
        <View style={{ width: 30, height: 30, borderRadius: t.radius.sm, backgroundColor: t.color.surface2, alignItems: "center", justifyContent: "center" }}>
          <Icon name={isServer ? "Server" : "Activity"} size={15} color={t.color.muted} />
        </View>
        <View style={{ flex: 1, minWidth: 100, gap: t.space.hair }}>
          <Text style={t.text.bodyStrong}>
            {process.name}
          </Text>
          <Text style={t.text.caption}>
            {process.classification.label}
          </Text>
        </View>
        <StatusPill tone={stateTone(process.state)} label={processStateWords(process.state, process.ports)} />
      </View>
      {process.ports.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          {process.ports.map((port) => (
            <Tag key={port} label={`:${port}`} />
          ))}
        </View>
      ) : null}
      <Facts
        items={[
          { value: `CPU ${formatPercent(process.cpuPercent, 1)}` },
          { value: `memory ${formatBytes(process.rssBytes)}` },
          { value: `up ${formatDuration(process.ageSeconds)}` },
        ]}
      />
      <Text style={t.text.caption}>{process.project ? `${process.project.name}${process.project.workspace ? ` · ${process.project.workspace}` : ""} · folder association` : "No workspace or chat identified"}</Text>
      <ProcessActions process={process} actions={actions} />
      {footer}
    </Card>
  );
}

// ------------------------------------------------------------------- rows

export function ProcessRow({ process, first, expanded, onToggle, actions }: { process: Process; first: boolean; expanded: boolean; onToggle: () => void; actions: RowActions }) {
  const t = useTokens();
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const compact = t.compact || (rowWidth !== null && rowWidth < 760);
  const tone = impactTone(process.impact);
  const flagged = process.impact === "pressure-driver" || process.impact === "high";
  const pending = actions.pending[processKey(process)];
  return (
    <View onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)} style={{ minWidth: 0, borderTopWidth: first ? 0 : 1, borderTopColor: t.color.borderSubtle, borderLeftWidth: flagged ? 2 : 0, borderLeftColor: flagged ? toneColor(t, tone) : "transparent" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${process.name}, PID ${process.pid}, CPU ${formatPercent(process.cpuPercent, 1)}, memory ${formatBytes(process.rssBytes)}. ${expanded ? "Collapse" : "Expand"} details`}
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => ({
          paddingVertical: compact ? t.space.md : t.space.sm + 2,
          paddingHorizontal: t.space.md,
          minHeight: t.control.min + 8,
          backgroundColor: pressed ? alpha(t.color.muted, 0.08) : "transparent",
          flexDirection: compact ? "column" : "row",
          alignItems: compact ? "stretch" : "center",
          gap: t.space.sm,
        })}
      >
        <View style={{ flex: 1, minWidth: 0, gap: t.space.hair }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm, minWidth: 0 }}>
            <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={t.color.muted} />
            <Text style={[t.text.bodyStrong, { flexShrink: 1 }]}>
              {process.name}
            </Text>
            {pending ? <Tag label={pending.survivedPolls >= FORCE_AFTER_POLLS ? "still running" : "stopping…"} tone={pending.survivedPolls >= FORCE_AFTER_POLLS ? "warning" : undefined} /> : null}
            {process.ports.length > 0 ? <Tag label={process.ports.map((port) => `:${port}`).join(" ")} /> : null}
          </View>
          <Text style={[t.text.caption, { marginLeft: t.space.card }]}>
            {process.project ? `${process.project.name} · ${process.project.kind === "agent" ? "Agent tool" : process.project.kind === "dev-server" ? "Dev server" : "Project tool"}` : process.classification.label}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: compact ? 10 : 12, marginLeft: compact ? 20 : 0, flexShrink: 0, flexWrap: compact ? "wrap" : "nowrap" }}>
          <TableFigure compact={compact} label="PID" value={String(process.pid)} width={65} />
          <TableFigure compact={compact} label="CPU" value={formatPercent(process.cpuPercent, 1)} width={70} />
          <TableFigure compact={compact} label="Memory" value={formatBytes(process.rssBytes)} width={85} />
          {!compact && <TableFigure compact={compact} label="Uptime" value={formatDuration(process.ageSeconds)} width={65} />}
          <View style={{ width: compact ? undefined : 132, alignItems: "flex-end" }}><StatusPill tone={tone} label={impactLabel(process.impact)} /></View>
        </View>
      </Pressable>
      {expanded ? (
        <View style={{ paddingHorizontal: t.space.md, paddingBottom: t.space.md, paddingLeft: t.space.md + 20, gap: t.space.sm }}>
          <Text style={t.text.mono} numberOfLines={3}>
            {process.command}
          </Text>
          <Facts
            items={[
              { value: `PID ${process.pid}` },
              { value: `parent ${process.ppid}` },
              { value: processStateWords(process.state, process.ports), tone: stateTone(process.state) === "warning" ? "warning" : undefined },
              { value: `${formatPercent(process.memoryPercent, 1)} of memory` },
              { value: `age ${formatDuration(process.ageSeconds)}` },
            ]}
          />
          {process.cwd ? <ProcessFolder process={process} /> : null}
          {process.classification.reasons.length > 0 ? <Text style={t.text.caption}>{process.classification.label}: {process.classification.reasons.join("; ")}</Text> : null}
          <ProcessActions process={process} actions={actions} />
        </View>
      ) : null}
    </View>
  );
}

/** 0.15.0: the folder as people read it ("site · apps/web"), then in full with Copy path. */
function ProcessFolder({ process }: { process: Process }) {
  const t = useTokens();
  const copy = useCopy();
  const project = process.project ?? null;
  const place = friendlyPath(process.cwd!, { roots: project ? [{ name: project.workspace ?? project.name, root: project.path }] : [] });
  const full = redactSecrets(process.cwdPath ?? process.cwd!);
  return (
    <View style={{ gap: t.space.xs }}>
      <Text style={t.text.caption}>{`In ${truncateMiddle(redactSecrets(place.label), pathWidth(t.compact))}`}</Text>
      <Text selectable style={t.text.caption}>{full}</Text>
      <View style={{ flexDirection: "row" }}><Button label="Copy path" icon="Copy" accessibilityLabel={`Copy the path ${full}`} onPress={() => void copy(process.cwdPath ?? process.cwd!, "Path copied")} /></View>
    </View>
  );
}

function TableFigure({ label, value, width, compact }: { label: string; value: string; width: number; compact: boolean }) {
  const t = useTokens();
  return (
    <View style={{ alignItems: "flex-end", width: compact ? undefined : width, minWidth: compact ? 44 : undefined }}>
      <Text style={t.text.figure}>{value}</Text>
      {compact && <Text style={t.text.small}>{label}</Text>}
    </View>
  );
}

/** Stop → preview and confirmation; after the process outlives the graceful attempt, Force Stop (modal). */
export function ProcessActions({ process, actions }: { process: Process; actions: RowActions }) {
  const t = useTokens();
  const target = `${process.name} (PID ${process.pid})`;
  const pending = actions.pending[processKey(process)];
  const busy = actions.stopping !== undefined && processKey(actions.stopping) === processKey(process);
  if (!process.actionable || !process.actionToken) {
    return <Text style={t.text.caption}>{process.protectedReason ?? "Protected"}</Text>;
  }
  if (pending && pending.survivedPolls >= FORCE_AFTER_POLLS) {
    return (
      <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "center", gap: t.space.sm }}>
        <Text style={[t.text.caption, { flex: 1 }]}>Still running after a graceful stop.</Text>
        <Button label="Force stop…" variant="danger" accessibilityLabel={`Force stop ${target}`} onPress={() => actions.onForce(process)} />
      </View>
    );
  }
  if (pending) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        <ActivityIndicator size="small" color={t.color.muted} />
        <Text style={[t.text.caption, { flex: 1, minWidth: 0 }]}>Waiting for {process.name} to exit…</Text>
      </View>
    );
  }
  return <View style={{ flexDirection: "row", flexWrap: "wrap", minWidth: 0 }}>
    <Button label="Stop…" variant="danger" icon="OctagonX" accessibilityLabel={`Stop ${target}…`} loading={busy} onPress={() => actions.onStop(process)} />
  </View>;
}

// ------------------------------------------------------------------- modal

export function ForceStopModal({ target, plan, theme, busy, onCancel, onConfirm }: { target: Process | null; plan?: StopPlan | null; theme?: PluginTheme; busy: boolean; onCancel: () => void; onConfirm: (process: Process) => void }) {
  const t = useTokens();
  const forceTheme = theme ?? { colors: { foreground: t.color.fg, foregroundMuted: t.color.muted, surface2: t.color.surface2, accent: t.color.accent, statusDanger: t.color.danger } } as PluginTheme;
  // Single use (0.15.0): two quick presses force-stop once.
  const confirmOnce = useOnce(target !== null, () => { if (target) onConfirm(target); });
  return (
    <Sheet
      title="Force stop process"
      icon={<Icon name="OctagonX" size={18} color={t.color.danger} />}
      open={target !== null}
      busy={busy} onClose={() => onCancel()} colors={{ surface: t.color.surface1, border: t.color.border, foreground: t.color.fg }}>
        <View style={{ gap: t.space.md, padding: t.compact ? t.space.md : t.space.lg }}>
          {target ? (
            <>
              <Text style={t.text.body}>
                Force stop <Text style={t.text.bodyStrong}>{target.name}</Text> (PID {target.pid})?
              </Text>
              <Text style={t.text.caption}>
                This sends SIGKILL. The process cannot clean up or save anything, and this cannot be undone. Only do this if it ignored the graceful stop.
              </Text>
              {plan ? <View style={{ gap: t.space.sm }}>
                {plan.targets.flatMap((item) => [...(item.workspaceWarnings ?? []), ...(item.tagWarnings ?? []), ...(item.outsidePaseo ? [OUTSIDE_PASEO_WARNING] : []), ...(!item.ok && item.reason ? [item.reason] : [])]).map((warning, index) => <Text key={index} style={t.text.body}>{warning}</Text>)}
                {plan.targets.map((item, index) => item.children.length ? <Text key={index} style={t.text.caption}>{`Children: ${item.children.map((child) => `${child.name} (PID ${child.pid})`).join(", ")}`}</Text> : null)}
              </View> : null}
              {target.ports.length > 0 ? <Text style={t.text.caption}>Listening on {target.ports.map((port) => `:${port}`).join(", ")}.</Text> : null}
              <View style={{ flexDirection: t.compact ? "column-reverse" : "row", justifyContent: "flex-end", gap: t.space.sm }}>
                <CancelButton theme={forceTheme} accessibilityLabel={`Cancel force stop of ${target.name}`} onPress={onCancel} disabled={busy} />
                <DestructiveButton theme={forceTheme} label="Force stop" accessibilityLabel={`Confirm force stop of ${target.name}, PID ${target.pid}`} onPress={confirmOnce} busy={busy} disabled={!!plan && !plan.targets.some((item) => item.ok)} />
              </View>
            </>
          ) : null}
        </View>
    </Sheet>
  );
}
