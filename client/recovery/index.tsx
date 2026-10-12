import React, { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Button, Field, Note, Row, SPACE, TYPE, Toggle } from "../kit";
import { CancelButton, Sheet, useOnce } from "../feedback";
import { PRESET_LABELS, RECOVERY_PROFILE_MAX, RecoveryDetailsSchema, recoveryCancel, recoveryConfirm, recoveryList, recoveryPreview, recoverySave, recoveryTest, recoveryWarning, recoveryActionLabel, type RecoveryAction, type RecoveryDetails, type RecoveryPreview, type RecoveryProfile, type RecoveryResult } from "../../shared/recovery";

const DEFAULT: RecoveryDetails = { name: "", hostname: "", user: "", port: null, auth: { kind: "config" }, preset: "docker", container: "paseo-dev-stack-paseo", unit: "paseo.service", sudo: false };
const TRANSPORT_ERROR = "Recovery could not reach this runner. Reconnect to an online helper in Paseo's host picker, then refresh. A submitted action may have taken effect; check before trying again.";

/** Only fixed recognised server messages may become UI errors. Never display arbitrary transport diagnostics. */
export function recoveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("The saved connection changed.")) return "The saved connection changed. Refresh the saved list, then reopen the form or review the action again.";
  if (message.includes("confirmation expired or was already used")) return "This confirmation expired or was already used. Review the action again.";
  if (message.includes("target name did not match")) return "The target name did not match. Review the reboot again.";
  if (message.includes("Recovery storage is unavailable.")) return "Recovery storage is unavailable on this runner. Check its owner-only permissions and symlink-free storage path.";
  if (message.includes("Wait for this connection")) return "An operation is pending for this connection. Wait before editing or removing it.";
  if (message.includes("Save up to 20")) return "This runner already has 20 saved connections. Remove one before adding another.";
  if (message.includes("Too many pending confirmations")) return "Too many confirmations are pending. Cancel one or wait a minute.";
  if (message.includes("Check the connection fields.")) return "Check the connection fields. Passwords, key contents and command text are not accepted.";
  return TRANSPORT_ERROR;
}

/** Embedded in the existing Hosts surface. The selected online host is the runner. */
export function RecoverySection(props: PluginSurfaceProps) { return <RecoveryBody key={props.host.id} {...props} />; }

export function RecoveryConfirmation({ theme, host, preview, busy, onConfirm, onCancel }: Pick<PluginSurfaceProps, "theme" | "host"> & {
  preview: RecoveryPreview; busy: boolean; onConfirm(targetName?: string): void; onCancel(): void;
}) {
  const [typed, setTyped] = useState("");
  const confirmOnce = useOnce(true, () => onConfirm(preview.action === "reboot" ? typed : undefined));
  const reboot = preview.action === "reboot";
  return <Sheet title={`${recoveryActionLabel(preview.profile, preview.action)}: ${preview.profile.name}`} open busy={busy} onClose={onCancel}
    colors={{ surface: theme.colors.surface1, border: theme.colors.border, foreground: theme.colors.foreground }}>
    <View style={{ padding: SPACE.md, gap: SPACE.row }}>
      <Note theme={theme} tone={reboot || preview.action === "restart" || preview.action === "container_restart" ? "danger" : "warning"}>{recoveryWarning(preview.profile, preview.action, host.label)}</Note>
      <Text style={{ ...TYPE.small, color: theme.colors.foregroundMuted }}>Recovery runner: {host.label}. Confirmation expires in one minute. No automatic retries.</Text>
      {reboot ? <Field theme={theme} label={`Type ${preview.profile.name} to confirm reboot`} value={typed} onChangeText={setTyped} placeholder="Target connection name" /> : null}
      <Row>
        <CancelButton theme={theme} onPress={onCancel} disabled={busy} />
        <Button theme={theme} label={recoveryActionLabel(preview.profile, preview.action)} danger={preview.action !== "start"} primary={preview.action === "start"} busy={busy}
          disabled={busy || (reboot && typed !== preview.profile.name)} onPress={confirmOnce} />
      </Row>
    </View>
  </Sheet>;
}

function ProfileForm({ theme, initial, busy, onSave, onCancel }: Pick<PluginSurfaceProps, "theme"> & {
  initial: RecoveryProfile | null; busy: boolean; onSave(details: RecoveryDetails): void; onCancel(): void;
}) {
  const [draft, setDraft] = useState<RecoveryDetails>(initial ?? DEFAULT);
  const [port, setPort] = useState(initial?.port ? String(initial.port) : "");
  const [identity, setIdentity] = useState(initial?.auth.kind === "identity" ? initial.auth.path : "");
  const [error, setError] = useState("");
  const change = <K extends keyof RecoveryDetails>(key: K, value: RecoveryDetails[K]) => setDraft(old => ({ ...old, [key]: value }));
  const submit = () => {
    // Strip server-only ID/revision from edit drafts. Only the declared connection fields cross RPC.
    const { name, hostname, user, preset, container, unit, sudo, auth } = draft;
    const parsed = RecoveryDetailsSchema.safeParse({ name, hostname, user, preset, container, unit, sudo,
      port: port.trim() ? Number(port) : null, auth: auth.kind === "config" ? { kind: "config" } : { kind: "identity", path: identity } });
    if (!parsed.success) { setError("Enter a name, hostname or SSH alias, valid user/port and preset target. Identity references must be absolute file paths on this runner. Command text and key contents are not accepted."); return; }
    setError(""); onSave(parsed.data);
  };
  return <View style={{ gap: SPACE.row, paddingVertical: SPACE.row }}>
    <Text style={{ ...TYPE.item, color: theme.colors.foreground }}>{initial ? "Edit saved connection" : "Save a recovery connection"}</Text>
    <Note theme={theme}>Saved here on this runner, even while the target is offline. No connection is made when saving.</Note>
    <Field theme={theme} label="Connection name" value={draft.name} onChangeText={value => change("name", value)} placeholder="Remote development" />
    <Field theme={theme} label="Target hostname or SSH alias" value={draft.hostname} onChangeText={value => change("hostname", value)} placeholder="dev.example.com" />
    <Field theme={theme} label="SSH user (blank uses SSH config)" value={draft.user} onChangeText={value => change("user", value)} placeholder="paseo" />
    <Field theme={theme} label="SSH port (blank uses SSH config)" value={port} onChangeText={setPort} placeholder="22" />
    <Row><Button theme={theme} label="SSH config / agent" primary={draft.auth.kind === "config"} onPress={() => change("auth", { kind: "config" })} />
      <Button theme={theme} label="Key file reference" primary={draft.auth.kind === "identity"} onPress={() => change("auth", { kind: "identity", path: identity })} /></Row>
    {draft.auth.kind === "identity" ? <Field theme={theme} label="Identity file path on this runner" value={identity} onChangeText={setIdentity} placeholder="/home/paseo/.ssh/recovery_ed25519" /> : null}
    <Note theme={theme}>The key must already be available on this runner. A laptop's 1Password SSH agent is unavailable when the laptop is off. Never paste a private key or password.</Note>
    <Row>{(["docker", "systemd"] as const).map(preset => <Button key={preset} theme={theme} label={PRESET_LABELS[preset]} primary={draft.preset === preset} onPress={() => change("preset", preset)} />)}</Row>
    {draft.preset === "docker" ? <Field theme={theme} label="Existing container name" value={draft.container} onChangeText={value => change("container", value)} placeholder="paseo-dev-stack-paseo" />
      : <Field theme={theme} label="Configured systemd unit" value={draft.unit} onChangeText={value => change("unit", value)} placeholder="paseo.service" />}
    <Toggle theme={theme} label="Use sudo -n on the target" value={draft.sudo} onChange={value => change("sudo", value)} disabled={busy} />
    <Note theme={theme}>Enable only with deliberately scoped non-interactive permissions on the target. Root runs directly. Docker worker commands run as the container's paseo user.</Note>
    {error ? <Note theme={theme} tone="danger">{error}</Note> : null}
    <Row><CancelButton theme={theme} disabled={busy} onPress={onCancel} /><Button theme={theme} label="Save connection" primary busy={busy} disabled={busy} onPress={submit} /></Row>
  </View>;
}

function RecoveryBody({ theme, host, layout }: PluginSurfaceProps) {
  const listRpc = useRpc(recoveryList), saveRpc = useRpc(recoverySave), testRpc = useRpc(recoveryTest);
  const previewRpc = useRpc(recoveryPreview), confirmRpc = useRpc(recoveryConfirm), cancelRpc = useRpc(recoveryCancel);
  const [profiles, setProfiles] = useState<RecoveryProfile[]>([]), [checks, setChecks] = useState<Record<string, RecoveryResult>>({});
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [form, setForm] = useState<{ profile: RecoveryProfile | null } | null>(null), [manage, setManage] = useState<string | null>(null);
  const [preview, setPreview] = useState<RecoveryPreview | null>(null), [setup, setSetup] = useState(false);
  const alive = useRef(true), pending = useRef(false), token = useRef<string | null>(null);
  const refresh = useCallback(async () => { const data = await listRpc({}); if (alive.current) { setProfiles(data.profiles); setChecks(data.checks); setLoaded(true); } }, [listRpc]);
  useEffect(() => { alive.current = true; void refresh().catch(error => { if (alive.current) setNotice(recoveryError(error)); });
    return () => { alive.current = false; if (token.current) void cancelRpc({ token: token.current }).catch(() => undefined); };
  }, [refresh, cancelRpc]);
  const act = async (job: () => Promise<void>) => {
    if (pending.current) return; pending.current = true; setBusy(true); setNotice("");
    try { await job(); } catch (error) { if (alive.current) setNotice(recoveryError(error)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const cancel = () => {
    const value = token.current; token.current = null; setPreview(null);
    if (value) void cancelRpc({ token: value }).catch(() => undefined);
  };
  const review = (profile: RecoveryProfile, action: RecoveryAction) => void act(async () => {
    const next = await previewRpc({ id: profile.id, revision: profile.revision, action });
    if (!alive.current) { await cancelRpc({ token: next.token }); return; }
    token.current = next.token; setPreview(next);
  });
  return <View accessibilityLabel="Hosts recovery" style={{ gap: SPACE.row, paddingVertical: layout.compact ? SPACE.sm : SPACE.md }}>
    <Text style={{ ...TYPE.section, color: theme.colors.foreground }}>Recovery connections</Text>
    <Text style={{ ...TYPE.secondary, color: theme.colors.foreground }}>Recovery runner: {host.label}</Text>
    <Note theme={theme}>When a target daemon stops, switch Paseo's host picker to this online helper, then use its saved connections. An offline Hosts panel cannot run recovery. If all helpers are down, use your provider's console.</Note>
    <Row><Button theme={theme} label="Add connection" disabled={busy || !loaded || profiles.length >= RECOVERY_PROFILE_MAX} onPress={() => { setForm({ profile: null }); setManage(null); }} />
      <Button theme={theme} label="Refresh saved list" disabled={busy} onPress={() => void act(refresh)} />
      <Button theme={theme} label={setup ? "Hide setup help" : "Setup help"} onPress={() => setSetup(value => !value)} /></Row>
    {setup ? <View style={{ gap: SPACE.sm }}><Note theme={theme}>Prepare a separate always-on Hosts helper and pair your phone with it. Its daemon user needs SSH access to the target, a verified known_hosts entry and a usable key file or agent. Save profiles on each helper independently. SSH cannot recover a powered-off host.</Note>
      <Button theme={theme} label="Open headless setup guide" onPress={() => { void Linking.openURL("https://github.com/itsjustanks/paseo-plugin-daemon/blob/main/docs/headless-setup.md").catch(() => setNotice("The guide could not open. See docs/headless-setup.md in the Hosts repository.")); }} /></View> : null}
    {notice ? <Note theme={theme} tone="warning">{notice}</Note> : null}
    {!loaded && !notice ? <Note theme={theme}>Loading saved connections from {host.label}…</Note> : loaded && profiles.length === 0 ? <Note theme={theme}>Save the target's SSH details here before you need recovery. Saving does not contact the target.</Note> : null}
    {profiles.map(profile => <View key={profile.id} style={{ borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: SPACE.row, gap: SPACE.sm }}>
      <Text style={{ ...TYPE.item, color: theme.colors.foreground }}>{profile.name}</Text>
      <Text style={{ ...TYPE.small, color: theme.colors.foregroundMuted }}>{profile.user ? `${profile.user}@` : ""}{profile.hostname}{profile.port ? `:${profile.port}` : ""} · {PRESET_LABELS[profile.preset]}</Text>
      <Text style={{ ...TYPE.small, color: theme.colors.foregroundMuted }}>{checks[profile.id] ? `Last check or request: ${new Date(checks[profile.id].checkedAt).toLocaleString()}. ${checks[profile.id].message}` : "Not checked on this runner yet."}</Text>
      <Row><Button theme={theme} label="Test SSH + status" disabled={busy} onPress={() => void act(async () => { const result = await testRpc({ id: profile.id, revision: profile.revision }); if (alive.current) setChecks(old => ({ ...old, [profile.id]: result })); })} />
        <Button theme={theme} label="Edit" disabled={busy} accessibilityLabel={`Edit ${profile.name}`} onPress={() => { setForm({ profile }); setManage(null); }} />
        <Button theme={theme} label={manage === profile.id ? "Hide actions" : "Manage"} disabled={busy} accessibilityLabel={`Manage ${profile.name}`} onPress={() => setManage(value => value === profile.id ? null : profile.id)} /></Row>
      {manage === profile.id ? <Row>{(profile.preset === "docker" ? ["start", "restart", "container_restart", "reboot", "remove"] as const : ["start", "restart", "reboot", "remove"] as const).map(action => <Button key={action} theme={theme} label={recoveryActionLabel(profile, action)} danger={action === "reboot"} disabled={busy} onPress={() => review(profile, action)} />)}</Row> : null}
    </View>)}
    {busy ? <Note theme={theme}>Waiting for this runner. SSH operations are bounded; an interrupted request is never retried automatically.</Note> : null}
    {form ? <ProfileForm key={form.profile?.id ?? "new"} theme={theme} initial={form.profile} busy={busy} onCancel={() => setForm(null)} onSave={details => void act(async () => {
      await saveRpc({ schemaVersion: 1, id: form.profile?.id, expectedRevision: form.profile?.revision ?? 0, details });
      if (alive.current) { setForm(null); setNotice("Connection saved on this runner. The target was not contacted."); } await refresh();
    })} /> : null}
    {preview ? <RecoveryConfirmation key={preview.token} theme={theme} host={host} preview={preview} busy={busy} onCancel={cancel} onConfirm={targetName => void act(async () => {
      const current = preview; token.current = null; setPreview(null);
      const result = await confirmRpc({ token: current.token, targetName });
      if (alive.current) setNotice(result.message); await refresh();
    })} /> : null}
  </View>;
}
