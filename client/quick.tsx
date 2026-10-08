import React, { useCallback, useEffect, useState, type ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { hostHealth, pillText, type HealthVerdict } from "../shared/health";
import { seconds } from "../shared/watch";
import { Button, Dot, Meta, Note, SPACE, TYPE, toneColor, type Tone } from "./kit";
import type { PopoverProps } from "./native";
import { RestartPlugin } from "./guard";
import { formatSize } from "../shared/disk";
import { formatBytes } from "./ui";

/**
 * Paseo 0.11's sidebar row can carry a trailing element and open a popover.
 * Hosts uses them for a status dot and a quick health check (memory, heavy
 * jobs, watched services, what's wrong) with a way into the full screen, so
 * the common question needs no trip into the panel. Older apps never render
 * these. No query client is needed: the dot reads the cached verdict itself.
 */
export type TrailingProps = { theme: PluginTheme; openPopover?: (Content: ComponentType<PopoverProps>) => void };

const POLL_MS = 60_000;

/** The cached verdict, read now and every minute while mounted; `refresh` checks now. */
function useVerdict(): { verdict: HealthVerdict | null; refresh(): Promise<void>; checking: boolean } {
  const call = useRpc(hostHealth);
  const [verdict, setVerdict] = useState<HealthVerdict | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () => void call({}).then((next) => { if (live) setVerdict(next); }).catch(() => undefined);
    read();
    const timer = setInterval(read, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [call]);
  const refresh = useCallback(async () => {
    setChecking(true);
    try { setVerdict(await call({ refresh: true })); } catch { /* Keep the last answer. */ } finally { setChecking(false); }
  }, [call]);
  return { verdict, refresh, checking };
}

/** The host in a word and a tone: what the dot shows. */
export function quickState(verdict: HealthVerdict | null): { tone: Tone; text: string; detail?: string | null } {
  if (!verdict) return { tone: "neutral", text: "Checking…" };
  const text = pillText({ status: verdict.status, issues: verdict.issues, services: verdict.services, ports: [...new Set(verdict.services.flatMap((service) => service.ports))].sort((a, b) => a - b), checkedAt: verdict.checkedAt });
  const count = verdict.issues.length;
  if (verdict.status === "critical") return { tone: "danger", text: count > 1 ? `${count} things need attention` : "Needs attention now", detail: text };
  if (verdict.status === "warning") return { tone: "warning", text: count > 1 ? `${count} things need attention` : "Needs attention", detail: text };
  if (verdict.status === "unknown") return { tone: "neutral", text: "Not checked yet" };
  return { tone: "success", text: text ? `All good · ${text}` : "All good" };
}

function dotColor(theme: PluginTheme, tone: Tone): string {
  return tone === "success" ? theme.colors.statusSuccess : toneColor(theme, tone);
}

const WATCH_TONE: Record<string, Tone> = { up: "success", slow: "warning", down: "danger", unknown: "neutral" };

export function makeQuickHealth(screenId: string): ComponentType<PopoverProps> {
  return function HostsQuickHealth({ theme, close, openScreen }: PopoverProps) {
    const { verdict, refresh, checking } = useVerdict();
    const state = quickState(verdict);
    const load = verdict?.load;
    // 0.14.0: a disk 85% full or more is one of the dot's states, and this links to where the space goes.
    const diskIssue = (verdict?.issues ?? []).some((issue) => issue.code === "disk-full");
    // 0.13.0: a stuck plugin and an automatic stop come first; they are the ones that take a daemon down or explain why something vanished.
    const rank = (code: string) => (code === "plugin-stuck" ? 0 : code === "auto-stopped" ? 1 : code === "memory-pressure" || code === "runaway" || code === "disk-full" ? 2 : 3);
    const issues = (verdict?.issues ?? []).filter((issue) => issue.code !== "service-slow" && issue.code !== "service-down" && issue.code !== "projects-unavailable")
      .map((issue, index) => ({ issue, index })).sort((a, b) => rank(a.issue.code) - rank(b.issue.code) || a.index - b.index).map(({ issue }) => issue).slice(0, 3);
    return (
      <View style={{ padding: SPACE.md, gap: SPACE.row, minWidth: 280, maxWidth: 380 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
          <Dot color={dotColor(theme, state.tone)} />
          <Text style={{ ...TYPE.item, color: theme.colors.foreground, flexShrink: 1 }}>{`Hosts · ${state.text}`}</Text>
        </View>
        {load ? (
          <View style={{ gap: SPACE.hair }}>
            <Note theme={theme}>{`Memory: ${formatBytes(load.memoryUsedBytes)} of ${formatBytes(load.memoryLimitBytes)}${load.memoryBasis === "container" ? " (container limit)" : ""}`}</Note>
            <Note theme={theme}>{`Heavy jobs: ${load.heavyJobs} running, ${load.heavyJobLimit} at once is the limit${load.cpuPercent === null ? "" : ` · CPU ${Math.round(load.cpuPercent)}%`}`}</Note>
            {verdict?.disk ? <Note theme={theme}>{`Disk: ${formatSize(verdict.disk.freeBytes)} free (${Math.round(verdict.disk.percent)}% used)`}</Note> : null}
          </View>
        ) : null}
        {issues.map((issue, index) => (
          <View key={`${issue.code}-${index}`} style={{ gap: SPACE.sm }}>
            <Note theme={theme} tone={issue.severity === "critical" ? "danger" : "warning"}>{issue.message}</Note>
            {issue.code === "plugin-stuck" ? <RestartPlugin theme={theme} issue={issue} onDone={() => void refresh()} /> : null}
          </View>
        ))}
        {(verdict?.watched ?? []).map((service) => (
          <View key={service.id} style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
            <Dot color={dotColor(theme, WATCH_TONE[service.state] ?? "neutral")} />
            <Text style={{ ...TYPE.secondary, color: theme.colors.foreground, flexShrink: 1 }}>{service.state === "up" && service.latencyMs !== null ? `${service.name} · ${seconds(service.latencyMs)}` : service.message}</Text>
          </View>
        ))}
        <Button theme={theme} label="Open Hosts" icon="Network" primary onPress={() => { openScreen({ screenId }); close(); }} />
        {diskIssue ? <Button theme={theme} label="Free up space" icon="HardDrive" onPress={() => { openScreen({ screenId, params: { tab: "workspaces" } }); close(); }} /> : null}
        <Button theme={theme} label="See heavy processes" icon="Cpu" onPress={() => { openScreen({ screenId, params: { tab: "processes" } }); close(); }} />
        <Button theme={theme} label="Check again" icon="RefreshCw" busy={checking} onPress={() => void refresh()} />
        {verdict ? <Meta theme={theme}>{`Checked ${new Date(verdict.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}</Meta> : null}
      </View>
    );
  };
}

/** The status dot at the end of the sidebar row; pressing it opens the quick check when the app can show a popover. */
export function makeStatusTrailing(Quick: ComponentType<PopoverProps>): ComponentType<TrailingProps> {
  return function HostsStatusDot({ theme, openPopover }: TrailingProps) {
    const state = quickState(useVerdict().verdict);
    const dot = <Dot color={dotColor(theme, state.tone)} />;
    if (!openPopover) return dot;
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`Hosts: ${state.text}${state.detail ? `, ${state.detail.replace(/\.+$/, "")}` : ""}. Quick health check`} hitSlop={SPACE.sm} onPress={() => openPopover(Quick)} style={{ padding: SPACE.xs }}>
        {dot}
      </Pressable>
    );
  };
}
