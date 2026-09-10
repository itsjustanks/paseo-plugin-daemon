import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { SNAPSHOT_INTERVAL_MAX, SNAPSHOT_INTERVAL_MIN, hostsSettings, type PanelScope } from "../shared/settings";

type Ready = Extract<SettingsState<typeof hostsSettings.schema>, { status: "ready" }>;

const SCOPES: ReadonlyArray<{ label: string; value: PanelScope }> = [
  { label: "This workspace only", value: "workspace" },
  { label: "Whole host", value: "host" },
];

function intervalError(text: string): string | null {
  if (!/^\d+$/.test(text.trim())) return "Enter a whole number of seconds.";
  const value = Number(text);
  if (value < SNAPSHOT_INTERVAL_MIN || value > SNAPSHOT_INTERVAL_MAX) return `Choose between ${SNAPSHOT_INTERVAL_MIN} and ${SNAPSHOT_INTERVAL_MAX} seconds.`;
  return null;
}

function HostsControls({ settings }: { settings: Ready }) {
  // The interval is a typed draft: it only persists once it is a valid number in range.
  const [intervalText, setIntervalText] = useState(String(settings.values.snapshotIntervalSeconds));
  const draftError = intervalError(intervalText);
  const dirty = !draftError && Number(intervalText) !== settings.values.snapshotIntervalSeconds;
  const save = useCallback((patch: Partial<Ready["values"]>) => { void settings.save({ ...settings.values, ...patch }, settings.revision); }, [settings]);
  const saveInterval = useCallback(() => { if (!draftError) save({ snapshotIntervalSeconds: Number(intervalText) }); }, [draftError, intervalText, save]);
  return (
    <>
      <SettingsSection title="Workspace panel" info="Controls the Hosts tab inside each workspace. The Hosts sidebar surface always shows the whole host.">
        <SettingsCard>
          <SettingsSelect<PanelScope>
            label="Panel shows"
            hint="Workspace only lists dev servers and processes running inside the open workspace's directory."
            value={settings.values.panelScope}
            options={SCOPES}
            disabled={settings.saving}
            onValueChange={(panelScope) => save({ panelScope })}
          />
          <SettingsInput
            label="Refresh interval (seconds)"
            hint={`Between ${SNAPSHOT_INTERVAL_MIN} and ${SNAPSHOT_INTERVAL_MAX}. Lower values use more CPU on the host.`}
            initialValue={String(settings.values.snapshotIntervalSeconds)}
            placeholder={String(settings.values.snapshotIntervalSeconds)}
            onChangeText={setIntervalText}
            disabled={settings.saving}
            error={draftError ?? undefined}
          />
          <SettingsAction label="Apply refresh interval" actionLabel="Save" disabled={settings.saving || !dirty} onPress={saveInterval} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Health checks" info="The daemon re-checks host health on the refresh interval and caches one verdict that every workspace reads.">
        <SettingsCard>
          <SettingsSwitch
            label="Check host health in the background"
            hint="Off means health only refreshes when a Hosts panel or pill asks for it."
            value={settings.values.backgroundHealthChecks}
            disabled={settings.saving}
            onValueChange={(backgroundHealthChecks) => save({ backgroundHealthChecks })}
          />
          <SettingsSwitch
            label="Show the composer pill"
            hint="A small chip under each agent's composer that counts the workspace's dev servers and flags problems. It hides itself when there is nothing to report."
            value={settings.values.showComposerPill}
            disabled={settings.saving}
            onValueChange={(showComposerPill) => save({ showComposerPill })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Workspace cleanup">
        <SettingsCard>
          <SettingsSwitch
            label="Close browser links on archive"
            hint="When a workspace is archived, stop temporary browser links that point at dev servers running inside it."
            value={settings.values.closeTunnelsOnArchive}
            disabled={settings.saving}
            onValueChange={(closeTunnelsOnArchive) => save({ closeTunnelsOnArchive })}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

export function HostsSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(hostsSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  if (settings.status === "loading") return <Text style={muted}>Loading Hosts settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Hosts">
        <Text accessibilityRole="alert" style={style}>{settings.error}</Text>
        <SettingsCard>
          <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
          {settings.status === "invalid" ? <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={settings.reset} /> : null}
        </SettingsCard>
      </SettingsSection>
    );
  }
  return (
    <>
      <HostsControls key={settings.revision} settings={settings} />
      {settings.saveError ? <Text accessibilityRole="alert" style={style}>{settings.saveError}</Text> : null}
    </>
  );
}
