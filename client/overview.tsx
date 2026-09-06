import React from "react";
import { Text, View } from "react-native";
import { Button, Card, Grid, StatusPill, useTokens } from "./ui";

export function HostOverview({ host, apps, projects, paired, forwards, ready, navigate }: {
  host: string; apps: number; projects: number; paired: number; forwards: number; ready: boolean;
  navigate(tab: "local" | "relay" | "sync" | "health" | "guide"): void;
}) {
  const t = useTokens();
  const steps = [
    { title: "Open a remote app", detail: "Bring an app from another Paseo host to a local port, or create a browser link for another device.", label: "Connect an app", tab: "relay" as const },
    { title: "Bring a project here", detail: "Choose a shared Git project, review its commit, and receive it into a separate checkout on this host.", label: "Preview a project transfer", tab: "sync" as const },
    { title: "Check this host", detail: "See CPU and memory pressure, then inspect only the processes associated with your Paseo projects.", label: "Open host health", tab: "health" as const },
  ];
  return <View style={{ gap: 20 }}>
    <View style={{ gap: 8 }}><Text style={[t.text.title, { fontSize: t.compact ? 26 : 32, lineHeight: 38 }]}>Your projects, across hosts.</Text><Text style={[t.text.body, { maxWidth: 680 }]}>You are managing {host}. Use Paseo's host picker to switch computers. Every local port, project checkout, and health reading below belongs to the selected host.</Text></View>
    <Grid min={180}>{[{ label: "Running project apps", value: apps }, { label: "Registered projects", value: projects }, { label: "Saved source hosts", value: paired }, { label: "Active local links", value: forwards }].map((item) => <Card key={item.label}><Text style={t.text.label}>{item.label}</Text><Text style={t.text.value}>{ready ? item.value : "—"}</Text></Card>)}</Grid>
    <Card><View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}><StatusPill tone={ready ? "ok" : "warning"} label={ready ? "Project access verified" : "Project access needs attention"} /><Text style={t.text.caption}>Daemon Link · selected host</Text></View><Text style={t.text.heading}>{!ready ? "Check project access before connecting" : apps ? `${apps} project apps are ready to share` : "Start with a project app"}</Text><Text style={t.text.body}>{!ready ? "Open Guide & Setup for the failed check and a recovery action." : apps ? "Open Local Projects to choose an app running here. Dev Relay connects an app running on another host." : "Open a registered project's terminal and run its normal dev command. Its server will appear in Local Projects."}</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Button label={ready ? "View local projects" : "Open setup checks"} variant="primary" onPress={() => navigate(ready ? "local" : "guide")} /><Button label="Read the walkthrough" onPress={() => navigate("guide")} /></View></Card>
    <Grid min={260}>{steps.map((step) => <Card key={step.tab}><Text style={t.text.heading}>{step.title}</Text><Text style={t.text.body}>{step.detail}</Text><Button label={step.label} onPress={() => navigate(step.tab)} /></Card>)}</Grid>
  </View>;
}
