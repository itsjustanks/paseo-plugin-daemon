import React, { useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { TabId } from "./navigation";
import { Bullets, Button, Card, Disclosure, Divider, HostIcon, IconBadge, Link, Meta, RADIUS, Row, SectionTitle, SPACE, TYPE, tint, toneColor } from "./kit";

type Theme = PluginTheme;
type Go = (tab: TabId) => void;

export interface SetupCheck { state: "ready" | "pending" | "optional" | "error"; title: string; detail: string }

/** Below this width the "How it works" steps stack top to bottom instead of left to right. */
const FLOW_STACK_WIDTH = 640;
const bold = { fontWeight: "700" } as const;

function useWidth(): [number | null, (event: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState<number | null>(null);
  return [width, (event) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next !== width) setWidth(next);
  }];
}

function Part({ theme, title, icon, children }: { theme: Theme; title: string; icon: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: SPACE.row }}>
      <SectionTitle theme={theme} icon={icon}>{title}</SectionTitle>
      {children}
    </View>
  );
}

function WhatIs({ theme }: { theme: Theme }) {
  const body = { ...TYPE.body, color: theme.colors.foreground };
  return (
    <Part theme={theme} title="What is Hosts?" icon="Network">
      <Text style={body}>Hosts keeps an eye on the computer or container this Paseo daemon runs on: how much memory and CPU it uses, which heavy jobs are running, and whether the services it depends on still answer.</Text>
      <Text style={body}>It also opens the dev servers running here, in your browser or privately on your own computer, and can copy projects between paired hosts.</Text>
    </Part>
  );
}

const FLOW = [
  { icon: "Eye", title: "Your daemon watches", text: "Every 30 seconds it measures memory, CPU and running jobs, and checks the services you watch." },
  { icon: "TriangleAlert", title: "It spots trouble", text: "A job stuck at full CPU, memory near the limit, too many builds at once, or a slow service." },
  { icon: "Hand", title: "You decide", text: "The sidebar dot and this page say what's wrong in plain words. Nothing is stopped without asking." },
  { icon: "ExternalLink", title: "Open what's running", text: "Each dev server opens in your browser with one press, or privately on your own computer." },
] as const;

function Arrow({ theme, down }: { theme: Theme; down: boolean }) {
  const glyph = HostIcon ? <HostIcon name={down ? "ArrowDown" : "ArrowRight"} size={20} color={theme.colors.foregroundMuted} /> : <Text style={{ ...TYPE.lead, color: theme.colors.foregroundMuted }}>{down ? "↓" : "→"}</Text>;
  return <View accessible={false} style={down ? { width: 48, alignItems: "center", paddingVertical: SPACE.hair } : { paddingTop: SPACE.md, width: 24, alignItems: "center" }}>{glyph}</View>;
}

function HowItWorks({ theme, compact }: { theme: Theme; compact: boolean }) {
  const [width, onLayout] = useWidth();
  const stacked = width === null ? compact : width < FLOW_STACK_WIDTH;
  return (
    <Part theme={theme} title="How it works" icon="Workflow">
      <View onLayout={onLayout} style={{ flexDirection: stacked ? "column" : "row", alignItems: stacked ? "stretch" : "flex-start" }}>
        {FLOW.map((step, index) => (
          <React.Fragment key={step.icon}>
            {index > 0 ? <Arrow theme={theme} down={stacked} /> : null}
            {stacked ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.row }}>
                <IconBadge theme={theme} name={step.icon} size={40} />
                <View style={{ flex: 1, gap: SPACE.hair }}>
                  <Text style={{ ...TYPE.item, color: theme.colors.foreground }}>{`${index + 1}. ${step.title}`}</Text>
                  <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{step.text}</Text>
                </View>
              </View>
            ) : (
              <View style={{ flex: 1, alignItems: "center", gap: SPACE.sm, paddingHorizontal: SPACE.xs }}>
                <IconBadge theme={theme} name={step.icon} size={44} />
                <Text style={{ ...TYPE.item, color: theme.colors.foreground, textAlign: "center" }}>{`${index + 1}. ${step.title}`}</Text>
                <Text style={{ ...TYPE.secondary, color: theme.colors.foreground, textAlign: "center" }}>{step.text}</Text>
              </View>
            )}
          </React.Fragment>
        ))}
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.row, padding: SPACE.row, borderRadius: RADIUS.control, backgroundColor: tint(theme.colors.accent, 0.07) ?? theme.colors.surface2 }}>
        {HostIcon ? <View style={{ paddingTop: SPACE.hair }}><HostIcon name="ShieldCheck" size={18} color={theme.colors.accent} /></View> : null}
        <Text style={{ ...TYPE.body, color: theme.colors.foreground, flex: 1 }}>
          <Text style={bold}>Safe by default.</Text>
          {" Nothing is published, paired or stopped until you press a button. Paseo itself, its plugins, agents and databases can never be stopped from here."}
        </Text>
      </View>
    </Part>
  );
}

function Step({ theme, n, children }: { theme: Theme; n: number; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.row }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.accent, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Text style={{ ...TYPE.secondary, color: theme.colors.accentForeground, fontWeight: "700" }}>{n}</Text>
      </View>
      <View style={{ flex: 1, gap: SPACE.hair, paddingTop: SPACE.hair }}>{children}</View>
    </View>
  );
}

function HowToUse({ theme, go }: { theme: Theme; go: Go }) {
  const body = { ...TYPE.body, color: theme.colors.foreground };
  return (
    <Part theme={theme} title="How to use it" icon="ListOrdered">
      <Step theme={theme} n={1}><Text style={body}>Glance at the dot beside <Text style={bold}>Hosts</Text> in the sidebar. Green is calm; press it for a quick check.</Text></Step>
      <Step theme={theme} n={2}>
        <Text style={body}>When things feel slow, open <Text style={bold}>Processes</Text>. The heaviest jobs are at the top, with the workspace or dev server that started them.</Text>
        <Link theme={theme} label="Open Processes" onPress={() => go("processes")} />
      </Step>
      <Step theme={theme} n={3}><Text style={body}>To stop a runaway, select it and press <Text style={bold}>Stop</Text>. You see exactly what will stop, children included, before anything happens.</Text></Step>
      <Step theme={theme} n={4}>
        <Text style={body}>Run a project's dev command in its Paseo terminal (such as <Text style={{ ...TYPE.mono }}>npm run dev</Text>). It appears under <Text style={bold}>Dev servers</Text> with an Open button.</Text>
        <Link theme={theme} label="Open Dev servers" onPress={() => go("servers")} />
      </Step>
      <Step theme={theme} n={5}><Text style={body}>Watch a service on another machine, such as OmniRoute, under <Text style={bold}>Settings → Hosts → Watched services</Text>. A slow or failing answer shows up here.</Text></Step>
    </Part>
  );
}

const CHECK_ICON: Record<SetupCheck["state"], { icon: string; tone: "success" | "danger" | "neutral" }> = {
  ready: { icon: "CircleCheck", tone: "success" }, error: { icon: "CircleAlert", tone: "danger" }, pending: { icon: "Circle", tone: "neutral" }, optional: { icon: "Circle", tone: "neutral" },
};

function Checks({ theme, host, checks, onRefresh }: { theme: Theme; host: string; checks: readonly SetupCheck[]; onRefresh(): void }) {
  return (
    <Part theme={theme} title={`Checks for ${host}`} icon="ListChecks">
      {checks.map((check) => (
        <View key={check.title} style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.row }}>
          {HostIcon ? <View style={{ paddingTop: SPACE.hair }}><HostIcon name={CHECK_ICON[check.state].icon} size={18} color={CHECK_ICON[check.state].tone === "neutral" ? theme.colors.foregroundMuted : toneColor(theme, CHECK_ICON[check.state].tone)} /></View> : null}
          <View style={{ flex: 1, gap: SPACE.hair }}>
            <Text style={{ ...TYPE.item, color: theme.colors.foreground }}>{`${check.title}${check.state === "optional" ? " · optional" : ""}`}</Text>
            <Meta theme={theme}>{check.detail}</Meta>
          </View>
        </View>
      ))}
      <Row><Button theme={theme} label="Run checks again" icon="RefreshCw" onPress={onRefresh} /></Row>
    </Part>
  );
}

function Troubleshooting({ theme }: { theme: Theme }) {
  return (
    <Part theme={theme} title="If something doesn't appear" icon="LifeBuoy">
      <Bullets theme={theme} icon="ChevronRight" items={[
        "A dev server shows only when it runs inside a project registered in Paseo, from that project's folder. A custom server needs a Paseo service script with its port.",
        "Register each project folder separately: your home folder or the whole disk is too broad and is ignored.",
        "After the daemon restarts, open Hosts on that host once so it can read its projects again.",
        "A private link needs both hosts online with Daemon Link running. If it won't connect, use a browser link or your SSH keys instead.",
      ]} />
    </Part>
  );
}

const WORDS = [
  { icon: "Server", term: "Host", text: "A computer or container running a Paseo daemon. Pick which one you're looking at with Paseo's host picker." },
  { icon: "HardDrive", term: "Memory limit", text: "A container can only use so much memory before its processes are stopped by the system. Hosts measures against that limit, not the whole machine." },
  { icon: "Hammer", term: "Heavy job", text: "A build, test run, type check, install or dev server. Several at once compete for the same CPU; your limit is in Settings." },
  { icon: "Flame", term: "Runaway", text: "A process stuck at a full CPU core for minutes, or holding a large share of memory." },
  { icon: "Globe", term: "Browser link", text: "A temporary public web address for one dev server. It works on any device and always expires." },
  { icon: "Laptop", term: "Private forward", text: "Makes a remote dev server answer at 127.0.0.1 on your own computer, over SSH or a paired host. Nothing is published." },
  { icon: "Link", term: "Paired host", text: "Another computer running Paseo and Daemon Link that you've trusted with a pairing code." },
  { icon: "Activity", term: "Watched service", text: "A health address on another machine, such as OmniRoute's, that the daemon checks regularly." },
] as const;

function Glossary({ theme }: { theme: Theme }) {
  return (
    <Part theme={theme} title="Words you'll see" icon="BookOpen">
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: SPACE.section, rowGap: SPACE.md }}>
        {WORDS.map((word) => (
          <View key={word.term} style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.row, flexBasis: 300, flexGrow: 1, flexShrink: 1 }}>
            <IconBadge theme={theme} name={word.icon} size={28} />
            <View style={{ flex: 1, gap: SPACE.hair }}>
              <Text style={{ ...TYPE.item, color: theme.colors.foreground }}>{word.term}</Text>
              <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{word.text}</Text>
            </View>
          </View>
        ))}
      </View>
    </Part>
  );
}

/**
 * Everything Overview teaches, in one card behind "New to Hosts? How it
 * works": what it is, how it works, how to use it, this host's checks,
 * troubleshooting and the words. Open while setup is unfinished; folded once
 * everything works.
 */
export function OverviewGuide({ theme, compact, go, host, checks, onRefresh, open }: { theme: Theme; compact: boolean; go: Go; host: string; checks: readonly SetupCheck[]; onRefresh(): void; open: boolean }) {
  return (
    <View style={{ marginBottom: SPACE.section }}>
      <Disclosure key={open ? "open" : "closed"} theme={theme} label="New to Hosts? How it works" openLabel="Hide how Hosts works" initiallyOpen={open}>
        <Card theme={theme} flush>
          <WhatIs theme={theme} />
          <Divider theme={theme} />
          <HowItWorks theme={theme} compact={compact} />
          <Divider theme={theme} />
          <HowToUse theme={theme} go={go} />
          <Divider theme={theme} />
          <Checks theme={theme} host={host} checks={checks} onRefresh={onRefresh} />
          <Divider theme={theme} />
          <Troubleshooting theme={theme} />
          <Divider theme={theme} />
          <Glossary theme={theme} />
        </Card>
      </Disclosure>
    </View>
  );
}
