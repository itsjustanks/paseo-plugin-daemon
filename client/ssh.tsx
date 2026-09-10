import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation } from "@tanstack/react-query";
import React, { useState } from "react";
import { Switch, Text, TextInput, View } from "react-native";
import * as rpc from "../shared/link";
import { Button, Card, Notice, Section, useTokens } from "./ui";
import { openExternal } from "./web";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Connection failed. Please retry.";

function Field({ label, value, onChange, numeric = false }: { label: string; value: string; onChange(value: string): void; numeric?: boolean }) {
  const t = useTokens();
  return <View style={{ gap: 4 }}><Text style={t.text.label}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChange} keyboardType={numeric ? "number-pad" : "default"} autoCapitalize="none" autoCorrect={false} style={{ ...t.text.body, backgroundColor: t.color.surface2, borderRadius: 6, padding: 10, borderColor: t.color.border, borderWidth: 1 }} /></View>;
}

/** `initialRemotePort` comes from a dev-server card's "Private forward" press, so the form starts on the right port. */
export function Connections({ profiles, states, refresh, initialRemotePort }: { profiles: rpc.Profile[]; states: rpc.LinkState[]; refresh(): void; initialRemotePort?: number }) {
  const t = useTokens();
  const toast = useToast();
  const save = useRpc(rpc.linkSave), connect = useRpc(rpc.linkConnect), disconnect = useRpc(rpc.linkDisconnect), remove = useRpc(rpc.linkRemove);
  const [editing, setEditing] = useState<string | undefined>();
  const [name, setName] = useState(""), [destination, setDestination] = useState("");
  const preset = String(initialRemotePort ?? 3000);
  const [sshPort, setSshPort] = useState("22"), [remotePort, setRemotePort] = useState(preset), [localPort, setLocalPort] = useState(preset);
  const [autoConnect, setAutoConnect] = useState(false);
  const mutation = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: refresh, onError: (err) => toast.error(errorMessage(err)) });
  return <>
    <Notice icon="Laptop">Select the daemon running on your own computer for SSH forwards. These local ports belong to that daemon's machine.{initialRemotePort ? ` The form below is preset for remote port ${initialRemotePort}.` : ""}</Notice>
    {profiles.map((profile) => {
      const state = states.find((s) => s.id === profile.id);
      return <Card key={profile.id}>
        <Text style={t.text.heading}>{profile.name}</Text><Text style={t.text.label}>{profile.destination}:{profile.remotePort} → localhost:{profile.localPort}</Text>
        <Text style={t.text.body}>{state?.message || "Disconnected"}</Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button label={state ? "Disconnect" : "Connect"} disabled={mutation.isPending} onPress={() => mutation.mutate(() => state ? disconnect({ id: profile.id }) : connect({ id: profile.id }))} />
          {state?.state === "connected" && <Button label="Open on this computer" onPress={() => { void openExternal(`http://localhost:${profile.localPort}`).catch((err) => toast.error(errorMessage(err))); }} />}
          <Button label="Edit" onPress={() => { setEditing(profile.id); setName(profile.name); setDestination(profile.destination); setSshPort(String(profile.sshPort)); setRemotePort(String(profile.remotePort)); setLocalPort(String(profile.localPort)); setAutoConnect(profile.autoConnect); }} />
          <Button label="Remove" disabled={mutation.isPending} onPress={() => mutation.mutate(() => remove({ id: profile.id }))} />
        </View>
      </Card>;
    })}
    <Section title={editing ? "Edit connection" : "Save a private connection"}><Card>
      <Field label="Connection name" value={name} onChange={setName} />
      <Field label="SSH config alias or user@hostname" value={destination} onChange={setDestination} />
      <Field label="SSH port" value={sshPort} onChange={setSshPort} numeric />
      <Field label="Remote service port" value={remotePort} onChange={setRemotePort} numeric />
      <Field label="Local port on this daemon" value={localPort} onChange={setLocalPort} numeric />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Switch accessibilityLabel="Reconnect when plugin starts" value={autoConnect} onValueChange={setAutoConnect} /><Text style={t.text.body}>Reconnect when plugin starts</Text></View>
      <Button label={mutation.isPending ? "Saving…" : "Save connection"} disabled={mutation.isPending || !name.trim() || !destination.trim()} onPress={() => mutation.mutate(async () => {
        await save({ id: editing, name, destination, sshPort: Number(sshPort), remotePort: Number(remotePort), localPort: Number(localPort), autoConnect });
        setEditing(undefined); setName(""); setDestination(""); toast.show("Connection saved", { variant: "success" });
      })} />
      <Text style={t.text.caption}>SSH uses the keys and known hosts on this daemon. Verify a new host's fingerprint once before using Connect. Password prompts are never hidden in the background.</Text>
    </Card></Section>
  </>;
}
