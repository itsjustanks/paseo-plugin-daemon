import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Button, Card, Grid, Section, alpha, useTokens } from "./ui";

/**
 * The setup walkthrough and checks that used to be the "Guide & Setup" tab.
 * They now live as a collapsed card at the bottom of Dev servers: visible
 * when you need them, out of the way once your servers are on screen.
 */

export type GuideNav = (target: "relay-private" | "relay-browser" | "relay-ssh" | "pair") => void;

export interface SetupCheck { state: "ready" | "pending" | "optional" | "error"; title: string; detail: string }

export function SetupGuide({ host, checks, expanded, onToggle, navigate, onRefresh, shortcuts }: {
  host: string; checks: SetupCheck[]; expanded: boolean; onToggle(): void; navigate: GuideNav; onRefresh(): void; shortcuts?: boolean;
}) {
  const t = useTokens();
  const failing = checks.filter((check) => check.state === "error").length;
  const waiting = checks.filter((check) => check.state === "pending").length;
  const summary = failing ? `${failing} check${failing === 1 ? "" : "s"} failing` : waiting ? `${waiting} step${waiting === 1 ? "" : "s"} left` : "All checks passed";
  return (
    <Card>
      <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "Collapse" : "Expand"} setup guide and checks, ${summary}`} accessibilityState={{ expanded }} onPress={onToggle}
        style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={16} color={t.color.muted} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={t.text.heading}>Setup guide & checks</Text>
          <Text style={t.text.caption}>{summary} · start a server, pair your computer, open it</Text>
        </View>
        <Icon name={failing ? "CircleAlert" : waiting ? "Circle" : "CircleCheck"} size={16} color={failing ? t.color.danger : waiting ? t.color.muted : t.color.success} />
      </Pressable>
      {expanded ? (
        <View style={{ gap: t.space.lg, paddingTop: t.space.sm }}>
          <Text style={[t.text.body, { maxWidth: 760 }]}>Each computer keeps its own localhost. Daemon Link either publishes a dev server behind a temporary browser link, or connects a chosen remote port to a local port on your computer while both plugins are running.</Text>
          <Grid min={270}>
            <Step number="1" title="Start the app on its host"><Text style={t.text.body}>Open the project in Paseo. In that project's terminal, run its normal dev command, such as:</Text><Text selectable style={t.text.mono}>npm run dev</Text><Text style={t.text.body}>Keep the terminal running. Next.js, Vite, and other recognized dev servers appear above without editing their source files.</Text></Step>
            <Step number="2" title="Pick a route"><Text style={t.text.body}>Press Open beside a server for a temporary browser link: it works from any device and needs nothing on your computer, but the URL is public for its lifetime. For a private route, pair both hosts (Connect → Private localhost) or save an SSH forward on your own computer's daemon; the app then lives at 127.0.0.1 on your laptop and nothing is published.</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Button label="Open pairing" onPress={() => navigate("pair")} /><Button label="SSH forwards" onPress={() => navigate("relay-ssh")} /></View></Step>
            <Step number="3" title="Keep it open"><Text style={t.text.body}>A browser link shows how long it has left and can be extended in place without a new URL, up to 24 hours from when it started. Closing a link or forward only removes access; the dev server keeps running.</Text><Text style={t.text.caption}>If the same port is busy on your laptop, Daemon Link chooses a free one for a private forward.</Text></Step>
          </Grid>
          <Section title={`Setup checks for ${host}`} trailing={<Button label="Run checks again" onPress={onRefresh} />}>
            {checks.map((check) => <Check key={check.title} {...check} />)}
          </Section>
          <Card><Text style={t.text.heading}>The app does not appear</Text><Text style={t.text.body}>Check that the project is registered in Paseo, the terminal is inside its directory, and the dev command is still running. For a custom server, configure a Paseo service script with its port. Unidentified listeners remain unavailable for sharing and stopping.</Text><Text style={t.text.caption}>Register individual project directories. The home directory or filesystem root is too broad. After a daemon restart, open Hosts on that host once so it can verify its project registry again.</Text></Card>
          <Card><Text style={t.text.heading}>The connection does not work</Text><Text style={t.text.body}>Confirm both hosts are online and their plugins are enabled. Select your own computer before opening a localhost forward. If the private relay cannot connect, switch to the app's host and use Open for a browser link, or use your existing SSH keys.</Text><Button label="Choose another connection method" onPress={() => navigate("relay-browser")} /></Card>
          <Card><Text style={t.text.heading}>What can be stopped?</Text><Text style={t.text.body}>Only a verified project dev server, after confirmation in Daemon Health. Agent tools are read-only here; manage sessions in their Paseo agent tabs. Closing a link only closes access to the app.</Text></Card>
          {shortcuts ? <Text style={t.text.caption}>You can also type /daemon-link in a workspace composer to open this panel.</Text> : null}
        </View>
      ) : null}
    </Card>
  );
}

function Step({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  const t = useTokens();
  return <Card><View style={{ width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: alpha(t.color.accent, 0.15) }}><Text style={[t.text.bodyStrong, { color: t.color.accent }]}>{number}</Text></View><Text style={t.text.heading}>{title}</Text>{children}</Card>;
}

function Check({ state, title, detail }: SetupCheck) {
  const t = useTokens();
  return <View style={{ flexDirection: "row", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderColor: t.color.border }}><Icon name={state === "ready" ? "CircleCheck" : state === "error" ? "CircleAlert" : "Circle"} size={18} color={state === "ready" ? t.color.success : state === "error" ? t.color.danger : t.color.muted} /><View style={{ flex: 1, gap: 3 }}><Text style={t.text.bodyStrong}>{title}{state === "optional" ? " · optional" : ""}</Text><Text style={t.text.caption}>{detail}</Text></View></View>;
}

/** Remembers whether the guide is open; a navigation that targets it opens it. */
export function useGuideState(initial = false) {
  const [expanded, setExpanded] = useState(initial);
  return { expanded, toggle: () => setExpanded((value) => !value), show: () => setExpanded(true) };
}
