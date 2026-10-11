import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { hostsSettings } from "../shared/settings";
import { HOUSEKEEPING_JOBS, housekeepingStatus, stateWords, type HousekeepingSettings } from "../shared/housekeeping";
import { Accordion, AccordionItem, Divider, ItemTitle, Meta, Note, Row, SPACE, TYPE } from "./kit";
import { CancelButton, DestructiveButton, errorText, Sheet } from "./feedback";
import { formatBytes } from "./ui";

type Ready = Extract<SettingsState<typeof hostsSettings.schema>, { status: "ready" }>;
const JOBS = { renice: "Lower priorities", reap: "Close leftovers", turbo: "Trim build caches", helpers: "Gate scripts" };

/** Shared native settings controls. Live mode is always an explicit decision; Cancel takes focus. */
export function HousekeepingControls({ theme, settings, supported, advanced = false }: { theme: PluginTheme; settings: Ready; supported: boolean; advanced?: boolean }) {
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const values = settings.values.housekeeping;
  useEffect(() => { setAsking(null); }, [settings.revision]);
  const save = async (patch: Partial<HousekeepingSettings>) => {
    if (busy.current) return;
    busy.current = true; setSaving(true); setError(null);
    try {
      const ok = await settings.save({ ...settings.values, housekeeping: { ...values, ...patch } }, settings.revision);
      if (ok) setAsking(null);
      else setError("The settings weren't saved. Reload and try again.");
    } catch (failure) { setError(errorText(failure)); }
    finally { busy.current = false; setSaving(false); }
  };
  const disabled = !supported || saving || settings.saving;
  const choose = (key: keyof HousekeepingSettings, label: string, choices: number[], hint: string) => {
    const options = [...new Set([...choices, Number(values[key])])].sort((a, b) => a - b).map((n) => ({ label: String(n), value: String(n) }));
    return <SettingsSelect<string> key={key} label={label} hint={hint} value={String(values[key])} options={options} disabled={disabled} onValueChange={(n) => void save({ [key]: Number(n) })} />;
  };
  return <>
    <SettingsCard>
      <SettingsSwitch label="Housekeeping on" hint="Linux only. Keeps this host tidy even when Hosts isn't open." value={values.enabled} disabled={disabled} onValueChange={(enabled) => void save({ enabled })} />
      <SettingsSwitch label="Preview only" hint="Logs what it would do. Turn this off to review and confirm live mode." value={values.dryRun} disabled={disabled} onValueChange={(dryRun) => { if (dryRun) void save({ dryRun: true }); else setAsking(settings.revision); }} />
      {advanced ? <>
        {choose("reniceIntervalMinutes", "Lower priorities every (minutes)", [1, 2, 5, 10, 15, 30, 60], "Checked each minute. Helpers are checked every minute too.")}
        {choose("reapIntervalMinutes", "Close eligible leftovers every (minutes)", [5, 15, 30, 60, 120, 360, 1440], "A schedule never authorizes a stop: every process still needs fresh finished-chat checks.")}
        {choose("turboIntervalHours", "Trim old caches every (hours)", [1, 6, 12, 24, 48, 168], "Only when the workspace and cache use are confirmed idle.")}
        {choose("browserMaxAgeHours", "Browser age to report (hours)", [1, 6, 12, 24, 168], "Age only reports a leftover. Closing always needs a finished chat.")}
        {choose("stuckQueryMaxHours", "Orphan query age (hours)", [1, 2, 6, 24, 72], "Also needs parent PID 1 and a closed or validated archived chat.")}
        {choose("turboCacheMaxDays", "Keep cache entries for (days)", [1, 7, 14, 30, 90, 365], "Only old, owned, regular Turborepo cache files. The workspace must be idle, with no same-user programs working in its folder.")}
        {choose("heavyNice", "Build priority (nice)", [1, 5, 10, 15, 19], "Higher is gentler. Only the main process; existing threads keep their priority.")}
        {choose("browserNice", "Browser priority (nice)", [1, 5, 10, 15, 19], "Only increases nice; never changes Paseo, plugins or agent programs.")}
      </> : null}
    </SettingsCard>
    {error || settings.saveError ? <Note theme={theme} tone="danger">{error ?? settings.saveError ?? ""}</Note> : null}
    {asking !== null ? <Sheet title="Turn on live Housekeeping?" open onClose={() => { if (!saving) setAsking(null); }} busy={saving} colors={{ surface: theme.colors.surface1, border: theme.colors.border, foreground: theme.colors.foreground }}>
      <View style={{ padding: SPACE.card, gap: SPACE.row }}>
        <Note theme={theme}>This host will lower build and browser priorities every {values.reniceIntervalMinutes} minutes, close eligible leftovers from finished chats every {values.reapIntervalMinutes} minutes, and delete old Turborepo cache files every {values.turboIntervalHours} hours. Deleted files cannot be restored.</Note>
        <Meta theme={theme}>Running chats, open idle chats and unknown owners stay protected. Turning it off or returning to preview cancels the current cycle.</Meta>
        {error ? <Note theme={theme} tone="danger">{error}</Note> : null}
        <Row><CancelButton theme={theme} disabled={saving} onPress={() => setAsking(null)} /><DestructiveButton theme={theme} label="Turn on live Housekeeping" busy={saving} disabled={disabled || asking !== settings.revision} onPress={() => void save({ dryRun: false })} /></Row>
      </View>
    </Sheet> : null}
  </>;
}

function useHousekeeping(hostId: string) {
  const read = useRpc(housekeepingStatus);
  return useQuery({ queryKey: ["daemon-link", hostId, "housekeeping"], queryFn: () => read({}), refetchInterval: 15_000, retry: 0 });
}

export function HousekeepingSettingsSection({ theme, hostId }: { theme: PluginTheme; hostId: string }) {
  const settings = useSettings(hostsSettings);
  const query = useHousekeeping(hostId);
  return <SettingsSection title="Housekeeping" info="Starts in preview on Linux. Review its decisions in Processes before confirming live mode. The memory guard is separate.">
    {query.data?.state === "unsupported" ? <Note theme={theme}>{query.data.message}</Note> : null}
    {settings.status === "ready" ? <HousekeepingControls theme={theme} settings={settings} supported={!!query.data && query.data.state !== "unsupported"} advanced /> : <Note theme={theme}>{settings.status === "loading" ? "Loading Housekeeping settings…" : settings.error}</Note>}
    {query.error ? <Note theme={theme} tone="danger">{errorText(query.error, "Housekeeping status couldn't be read.")}</Note> : null}
  </SettingsSection>;
}

/** One small section of Processes; detail stays folded until requested. */
export function HousekeepingSection({ theme, hostId, compact }: { theme: PluginTheme; hostId: string; compact: boolean }) {
  const query = useHousekeeping(hostId);
  const settings = useSettings(hostsSettings);
  const data = query.data;
  const words = data ? stateWords(data) : null;
  return <Accordion theme={theme}><AccordionItem theme={theme} compact={compact} title="Housekeeping" icon="Brush" summary={words?.title ?? (query.error ? "Status unavailable" : "Reading status…")}>
    <Note theme={theme}>{data?.message ?? (query.error ? errorText(query.error, "Housekeeping status couldn't be read.") : "Reading this host's Housekeeping status…")}</Note>
    {data?.machine ? <Meta theme={theme}>{`${formatBytes(data.machine.freeBytes)} free of ${formatBytes(data.machine.totalBytes)} ${data.machine.basis === "container" ? "container RAM" : "RAM"} · 1-minute load ${data.machine.load1.toFixed(2)} · ${data.machine.cores} cores`}</Meta> : null}
    {data?.state !== "unsupported" && settings.status === "ready" ? <HousekeepingControls theme={theme} settings={settings} supported={!!data} /> : null}
    {data && data.state !== "unsupported" ? <>
      <Divider theme={theme} /><ItemTitle theme={theme}>Last runs and results</ItemTitle>
      {HOUSEKEEPING_JOBS.map((job) => <View key={job} style={{ gap: SPACE.xs }}><Text style={{ ...TYPE.secondary, color: theme.colors.foreground }}>{JOBS[job]}</Text><Meta theme={theme}>{data.lastRuns[job] ? `${new Date(data.lastRuns[job]!.at).toLocaleString()} · ${data.lastRuns[job]!.summary}` : "Hasn't run yet"}</Meta></View>)}
      {data.actions.length ? data.actions.slice(0, 20).map((entry, i) => <View key={`${entry.at}-${i}`} style={{ gap: SPACE.xs }}><Text style={{ ...TYPE.secondary, color: theme.colors.foreground }}>{`${entry.outcome === "preview" ? "Preview" : entry.outcome} · ${entry.what}`}</Text><Note theme={theme}>{entry.why}</Note><Meta theme={theme}>{new Date(entry.at).toLocaleString()}</Meta></View>) : <Note theme={theme}>No results yet. The first cycle starts within a minute; preview records what it would change.</Note>}
    </> : null}
  </AccordionItem></Accordion>;
}
