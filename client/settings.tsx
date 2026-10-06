import { useCallback, useMemo, useRef, useState } from "react";
import { Text } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { SNAPSHOT_INTERVAL_MAX, SNAPSHOT_INTERVAL_MIN, WATCHED_SERVICES_MAX, hostsSettings, type PanelScope } from "../shared/settings";
import { watchId, watchSuggestions, watchTarget, watchUrlProblem } from "../shared/watch";
import { TUNNEL_MINUTES, TUNNEL_MINUTES_DEFAULT, formatMinutes, isTunnelMinutes } from "../shared/tunnel-lease";

type Ready = Extract<SettingsState<typeof hostsSettings.schema>, { status: "ready" }>;

const SCOPES: ReadonlyArray<{ label: string; value: PanelScope }> = [
  { label: "This workspace only", value: "workspace" },
  { label: "Whole host", value: "host" },
];
/** The select speaks strings; the document stores the number. */
const DURATIONS: ReadonlyArray<{ label: string; value: string }> = TUNNEL_MINUTES.map((minutes) => ({
  label: `${formatMinutes(minutes).replace(" min", " minutes").replace(/ h$/, minutes === 60 ? " hour" : " hours")}${minutes === TUNNEL_MINUTES_DEFAULT ? " (default)" : ""}`,
  value: String(minutes),
}));

const JOB_LIMITS: ReadonlyArray<{ label: string; value: string }> = [2, 3, 4, 6, 8, 12, 16].map((n) => ({ label: `${n} at once${n === 4 ? " (default)" : ""}`, value: String(n) }));

function statusError(text: string): string | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return /^\d{3}$/.test(text.trim()) && value >= 100 && value <= 599 ? null : "Enter a status code such as 200, or leave it empty.";
}

/**
 * Watched services: health URLs on other machines, checked on the health
 * schedule. Adding validates the URL (http/https, no secrets) before saving;
 * the AI Router's OmniRoute is offered in one press when it is set up here.
 */
function WatchedServices({ settings, save }: { settings: Ready; save(patch: Partial<Ready["values"]>): void }) {
  const suggestionsRpc = useRpc(watchSuggestions);
  const suggestions = useQuery({ queryKey: ["daemon-link", "settings", "watch-suggestions", settings.revision], queryFn: () => suggestionsRpc({}), retry: 0 });
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [tried, setTried] = useState(false);
  const nameRef = useRef<SettingsInputHandle>(null), urlRef = useRef<SettingsInputHandle>(null), statusRef = useRef<SettingsInputHandle>(null);
  const list = settings.values.watchedServices;
  const full = list.length >= WATCHED_SERVICES_MAX;
  const urlProblem = url ? watchUrlProblem(url) : tried ? watchUrlProblem("") : null;
  const nameProblem = tried && !name.trim() ? "Give it a short name, such as OmniRoute." : null;
  const add = (entry: { name: string; url: string; expectedStatus: number | null }) => save({ watchedServices: [...list, { id: watchId(entry.name, list.map((item) => item.id)), ...entry }] });
  const submit = () => {
    setTried(true);
    if (!name.trim() || watchUrlProblem(url) || statusError(status)) return;
    add({ name: name.trim().slice(0, 60), url: url.trim(), expectedStatus: status.trim() ? Number(status) : null });
    for (const ref of [nameRef, urlRef, statusRef]) ref.current?.replaceText("");
    setName(""); setUrl(""); setStatus(""); setTried(false);
  };
  return (
    <SettingsSection title="Watched services" info="Health addresses on other machines, such as OmniRoute's. The daemon checks each one on the refresh interval (at most every 30 seconds, 5 second timeout) and flags it when it is slow or doesn't answer. Addresses must not contain passwords or keys.">
      {list.length ? (
        <SettingsCard>
          {list.map((service) => (
            <SettingsAction key={service.id} label={service.name} hint={`${watchTarget(service.url)}${service.expectedStatus ? ` · expects ${service.expectedStatus}` : ""}`} actionLabel="Remove" disabled={settings.saving} onPress={() => save({ watchedServices: list.filter((item) => item.id !== service.id) })} />
          ))}
        </SettingsCard>
      ) : null}
      {suggestions.data?.suggestions.map((suggestion) => (
        <SettingsCard key={suggestion.url}>
          <SettingsAction label={`Watch ${suggestion.name}`} hint={`${suggestion.why} Checks ${watchTarget(suggestion.url)}.`} actionLabel="Watch" disabled={settings.saving || full} onPress={() => add({ name: suggestion.name, url: suggestion.url, expectedStatus: null })} />
        </SettingsCard>
      ))}
      <SettingsCard>
        <SettingsInput ref={nameRef} label="Name" hint="Shown in Hosts, such as OmniRoute." placeholder="OmniRoute" onChangeText={setName} disabled={settings.saving || full} error={nameProblem} />
        <SettingsInput ref={urlRef} label="Health URL" hint="http:// or https://, without a user name, password or key." placeholder="http://10.0.0.9:20128/api/health/ping" onChangeText={setUrl} disabled={settings.saving || full} error={urlProblem} />
        <SettingsInput ref={statusRef} label="Expected status (optional)" hint="Leave empty to accept any 2xx or 3xx answer." placeholder="200" onChangeText={setStatus} disabled={settings.saving || full} error={statusError(status)} />
        <SettingsAction label={full ? `Up to ${WATCHED_SERVICES_MAX} services can be watched` : "Add this service"} actionLabel="Add" disabled={settings.saving || full} onPress={submit} />
      </SettingsCard>
    </SettingsSection>
  );
}

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
      <SettingsSection title="Workspace panel" info="Controls the Hosts tab inside each workspace. The Hosts screen in the sidebar always shows the whole host.">
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
      <SettingsSection title="Health checks" info="The daemon re-checks host health on the refresh interval (memory, CPU, heavy jobs and watched services) and keeps one answer that every workspace and the sidebar dot read.">
        <SettingsCard>
          <SettingsSwitch
            label="Check host health in the background"
            hint="Off means health only refreshes when a Hosts panel or pill asks for it."
            value={settings.values.backgroundHealthChecks}
            disabled={settings.saving}
            onValueChange={(backgroundHealthChecks) => save({ backgroundHealthChecks })}
          />
          <SettingsSwitch
            label="Show a chip when a chat needs attention"
            hint="A small chip under a chat's message box, only when that workspace needs you: its dev server stopped, a link failed, or one of its jobs is slowing the host down. A calm chat shows nothing."
            value={settings.values.showComposerPill}
            disabled={settings.saving}
            onValueChange={(showComposerPill) => save({ showComposerPill })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Heavy processes" info="Builds, tests, type checks, installs and dev servers running at once. Going over the limit is flagged in Hosts and on the sidebar dot. Nothing is ever stopped automatically.">
        <SettingsCard>
          <SettingsSelect<string>
            label="Heavy jobs at once"
            hint="On an 8-core host, 4 keeps builds from slowing each other down."
            value={String(settings.values.maxHeavyJobs)}
            options={JOB_LIMITS.some((option) => option.value === String(settings.values.maxHeavyJobs)) ? JOB_LIMITS : [...JOB_LIMITS, { label: `${settings.values.maxHeavyJobs} at once`, value: String(settings.values.maxHeavyJobs) }]}
            disabled={settings.saving}
            onValueChange={(value) => save({ maxHeavyJobs: Number(value) })}
          />
        </SettingsCard>
      </SettingsSection>
      <WatchedServices settings={settings} save={save} />
      <SettingsSection title="Browser links" info="A temporary browser link is a public HTTPS URL to one verified dev server. It always expires; Extend renews a live link without a new URL, up to 24 hours after it was started.">
        <SettingsCard>
          <SettingsSelect<string>
            label="Link duration"
            hint="How long Open keeps a new link alive, and how much each Extend adds. Longer is more convenient; shorter limits how long the URL stays public."
            value={String(settings.values.tunnelMinutes)}
            options={DURATIONS}
            disabled={settings.saving}
            onValueChange={(value) => { const minutes = Number(value); if (isTunnelMinutes(minutes)) save({ tunnelMinutes: minutes }); }}
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
