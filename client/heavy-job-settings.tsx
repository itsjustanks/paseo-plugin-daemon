import React from "react";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSelect } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { hostsSettings, MAX_HEAVY_JOBS_DEFAULT } from "../shared/settings";
import { Button, Meta, Note, Row } from "./kit";

const THRESHOLDS = Array.from({ length: 32 }, (_, index) => {
  const count = index + 1;
  return { value: String(count), label: `More than ${count} ${count === 1 ? "job" : "jobs"}${count === MAX_HEAVY_JOBS_DEFAULT ? " (default)" : ""}` };
});

/** Shared by the full settings screen and the process summary's settings sheet. */
export function HeavyJobThresholdSelect({ value, disabled, onChange }: { value: number; disabled: boolean; onChange(value: number): void }) {
  return <SettingsSelect<string> label="Heavy-job warning threshold"
    hint="Warn when the running count is higher than this number. Default: 4. This is a fixed starting value, not a measurement of this host's capacity. The warning never stops or blocks jobs."
    value={String(value)} options={THRESHOLDS} disabled={disabled} onValueChange={(next) => onChange(Number(next))} />;
}

export function HeavyJobSettings({ theme }: { theme: PluginTheme }) {
  const settings = useSettings(hostsSettings);
  if (settings.status === "loading") return <Note theme={theme}>Loading the saved warning threshold…</Note>;
  if (settings.status !== "ready") return <><Note theme={theme} tone="warning">{settings.error}</Note><Row><Button theme={theme} label="Reload settings" onPress={settings.reload} /></Row></>;
  return <>
    <SettingsCard><HeavyJobThresholdSelect value={settings.values.maxHeavyJobs} disabled={settings.saving}
      onChange={(maxHeavyJobs) => { void settings.save({ ...settings.values, maxHeavyJobs }, settings.revision); }} /></SettingsCard>
    <Meta theme={theme}>Memory guard and Housekeeping are controlled separately in Settings → Hosts. Changing this warning threshold leaves those policies as they are.</Meta>
    {settings.saveError ? <Note theme={theme} tone="warning">{settings.saveError}</Note> : null}
  </>;
}
