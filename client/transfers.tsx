import React, { useState } from "react";
import { Clipboard, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as rpc from "../shared/sync";
import * as peer from "../shared/peers";
import { Button, Card, Notice, StatusPill, formatBytes, useTokens } from "./ui";

export function Transfers({ hostId, openPairing }: { hostId: string; openPairing(): void }) {
  const t = useTokens();
  const [view, setView] = useState<"receive" | "share" | "history">("receive");
  const [peerId, setPeerId] = useState("");
  const statusRpc = useRpc(rpc.syncStatus), peersRpc = useRpc(peer.peerStatus), projectsRpc = useRpc(rpc.syncProjects);
  const previewRpc = useRpc(rpc.syncPreview), receiveRpc = useRpc(rpc.syncReceive), shareRpc = useRpc(rpc.syncShare);
  const status = useQuery({ queryKey: ["hosts-sync", hostId, "status"], queryFn: () => statusRpc({}), refetchInterval: 3000, retry: 1 });
  const peers = useQuery({ queryKey: ["hosts-sync", hostId, "peers"], queryFn: () => peersRpc({}), retry: 1 });
  const projects = useQuery({ queryKey: ["hosts-sync", hostId, "projects", peerId], queryFn: () => projectsRpc({ peerId }), enabled: !!peerId, retry: 1 });
  const preview = useMutation({ mutationFn: (projectId: string) => previewRpc({ peerId, projectId }) });
  const receive = useMutation({ mutationFn: (token: string) => receiveRpc({ peerId, token }), onSuccess: () => { preview.reset(); setView("history"); void status.refetch(); } });
  const share = useMutation({ mutationFn: shareRpc, onSuccess: () => { void status.refetch(); } });
  const error = [status.error, peers.error, projects.error, preview.error, receive.error, share.error].find(Boolean);
  const running = status.data?.history.some((entry) => entry.state === "receiving");
  return <View style={{ gap: t.space.lg }}>
    <Text style={t.text.caption}>Transfers run only when you ask, and copy committed Git history (up to 32 MiB) into a separate checkout. Folders, chat sessions, uncommitted files, Git LFS objects and submodule contents are not copied.</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>{([ ["receive", "Receive a project"], ["share", "Share with a host"], ["history", "Transfer history"] ] as const).map(([id, label]) => <Button key={id} label={label} variant={view === id ? "primary" : "secondary"} onPress={() => setView(id)} />)}</View>
    {error ? <Notice icon="TriangleAlert" tone="danger">{error instanceof Error ? error.message : "Transfer information could not be loaded."}</Notice> : null}
    {view === "receive" ? <>
      <Card><Text style={t.text.heading}>Choose the receiving host first</Text><Text style={t.text.body}>The selected Paseo host receives the checkout. Choose a paired source below. On that source, open Hosts → Overview → Copy a project from another computer → Share with a host, and allow this pairing to download the project.</Text><Button label="Open host pairing" onPress={openPairing} /></Card>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>{peers.data?.peers.map((item) => <Button key={item.id} label={item.label} variant={peerId === item.id ? "primary" : "secondary"} onPress={() => { setPeerId(item.id); preview.reset(); receive.reset(); }} />)}</View>
      {!peers.data?.peers.length && !peers.isLoading ? <Notice icon="Info">No paired sources yet. Pair two hosts first (Dev servers → Open privately on your own computer), then allow project access separately.</Notice> : null}
      {peerId ? <Card><Text style={t.text.heading}>Projects shared by this host</Text><Button label="Refresh shared projects" loading={projects.isFetching} onPress={() => { void projects.refetch(); }} />{projects.isLoading ? <Text style={t.text.body}>Checking project sharing…</Text> : null}{projects.data?.projects.length === 0 ? <Text style={t.text.body}>This pairing has no shared projects. Enable selected projects on the source host; dev-server access alone does not grant file access.</Text> : null}{projects.data?.projects.map((project) => <View key={project.id} style={{ gap: t.space.sm, borderTopWidth: 1, borderColor: t.color.border, paddingTop: t.space.md }}><Text style={t.text.bodyStrong}>{project.name}</Text><Button label={`Preview ${project.name}`} disabled={!!running || preview.isPending} loading={preview.isPending && preview.variables === project.id} onPress={() => preview.mutate(project.id)} /></View>)}</Card> : null}
      {preview.data ? <Card><Text style={t.text.heading}>Review {preview.data.project.name}</Text><Text style={t.text.body}>{preview.data.commits} commits · {formatBytes(preview.data.bytes)} · commit {preview.data.head.slice(0, 12)}</Text><Text style={t.text.body}>This receives exactly the prepared commit into a new checkout under this host's plugin state directory. Existing projects and branches are left as they are. Committed files and history can contain private project data.</Text><Text style={t.text.caption}>Preview expires at {new Date(preview.data.expiresAt).toLocaleTimeString()}. Submodules and Git LFS content require their own setup after receiving.</Text><Button label="Receive into a new checkout" variant="primary" loading={receive.isPending} disabled={!!running || preview.isPending || preview.data.expiresAt <= Date.now()} onPress={() => receive.mutate(preview.data!.token)} /><Button label="Discard preview" onPress={() => preview.reset()} /></Card> : null}
    </> : null}
    {view === "share" ? <>
      <Card><Text style={t.text.heading}>Project access is separate from dev-server access</Text><Text style={t.text.body}>Each pairing starts with no project access. Allow only the projects you want its holder to download. Permission includes the checkout's committed history, which may contain private files. Clearing a project stops future downloads; received copies stay on the other host.</Text><Button label="Create or review pairing codes" onPress={openPairing} /></Card>
      {!status.data?.grants.length ? <Notice icon="Info">Create a pairing code on this source host first. No projects are shared automatically.</Notice> : null}
      {status.data?.grants.map((grant) => <Card key={grant.id}><Text style={t.text.heading}>Pairing: {grant.label}</Text><Text style={t.text.caption}>Code identifier {grant.id.slice(0, 8)} · {grant.projectIds.length} project permissions</Text>{status.data.projects.map((project) => { const allowed = grant.projectIds.includes(project.id); return <View key={project.id} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm }}><Text style={[t.text.body, { flex: 1, minWidth: 120 }]}>{project.name}</Text><Button label={allowed ? `Stop sharing ${project.name}` : `Share ${project.name}`} disabled={share.isPending} onPress={() => share.mutate({ grantId: grant.id, projectIds: allowed ? grant.projectIds.filter((id) => id !== project.id) : [...grant.projectIds, project.id] })} /></View>; })}</Card>)}
    </> : null}
    {view === "history" ? <>
      <Card><Text style={t.text.heading}>Recent transfers on this host</Text><Text style={t.text.body}>History records the latest 50 receives, including failures and interruptions. It is a transfer log, not an automatic backup or a rollback command.</Text><Button label="Refresh transfer history" loading={status.isFetching} onPress={() => { void status.refetch(); }} /></Card>
      {!status.data?.history.length ? <Notice icon="Info">No transfers yet. Pair a source, enable project sharing there, then preview a project here.</Notice> : null}
      {status.data?.history.map((entry) => <Card key={entry.id}><View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: t.space.sm }}><Text style={t.text.heading}>{entry.projectName}</Text><StatusPill label={entry.state} tone={entry.state === "done" ? "ok" : entry.state === "receiving" ? "neutral" : "warning"} /></View><Text style={t.text.caption}>{new Date(entry.startedAt).toLocaleString()} · {entry.head.slice(0, 12)} · {formatBytes(entry.bytes)}</Text><Text style={t.text.body}>{entry.message}</Text>{entry.directory ? <><Text selectable style={t.text.caption}>{entry.directory}</Text><Button label="Copy received project path" onPress={() => Clipboard.setString(entry.directory!)} /><Text style={t.text.caption}>Open this directory as a project in Paseo when you want to use the received checkout.</Text></> : null}</Card>)}
    </> : null}
  </View>;
}
