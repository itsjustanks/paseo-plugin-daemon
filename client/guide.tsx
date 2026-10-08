import React, { useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { Fold, TabId } from "../shared/tabs";
import { Accordion, AccordionItem, Button, Divider, HostIcon, IconBadge, Link, Meta, RADIUS, Row, SectionTitle, SPACE, TYPE, tint, toneColor } from "./kit";

type Theme = PluginTheme;
type Go = (tab: TabId, fold?: Fold) => void;

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
  { icon: "TriangleAlert", title: "It spots trouble", text: "A job stuck at full CPU or eating memory, a disk filling up, a plugin that stopped answering, or a slow service." },
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
        <Text style={body}>Run a project's dev command in its Paseo terminal (such as <Text style={{ ...TYPE.mono }}>npm run dev</Text>). It appears under <Text style={bold}>Workspaces</Text> with an Open button.</Text>
        <Link theme={theme} label="Open Workspaces" onPress={() => go("workspaces")} />
      </Step>
      <Step theme={theme} n={5}><Text style={body}>Watch a service on another machine, such as OmniRoute, under <Text style={bold}>Settings → Hosts → Watched services</Text>. A slow or failing answer shows up here.</Text></Step>
    </Part>
  );
}

const CHECK_ICON: Record<SetupCheck["state"], { icon: string; tone: "success" | "danger" | "neutral" }> = {
  ready: { icon: "CircleCheck", tone: "success" }, error: { icon: "CircleAlert", tone: "danger" }, pending: { icon: "Circle", tone: "neutral" }, optional: { icon: "Circle", tone: "neutral" },
};

/** This host's setup checks, for Overview's "Setup checks" fold-out. */
export function Checks({ theme, checks }: { theme: Theme; checks: readonly SetupCheck[] }) {
  return (
    <>
      {checks.map((check) => (
        <View key={check.title} style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.row }}>
          {HostIcon ? <View style={{ paddingTop: SPACE.hair }}><HostIcon name={CHECK_ICON[check.state].icon} size={18} color={CHECK_ICON[check.state].tone === "neutral" ? theme.colors.foregroundMuted : toneColor(theme, CHECK_ICON[check.state].tone)} /></View> : null}
          <View style={{ flex: 1, gap: SPACE.hair }}>
            <Text style={{ ...TYPE.item, color: theme.colors.foreground }}>{`${check.title}${check.state === "optional" ? " · optional" : ""}`}</Text>
            <Meta theme={theme}>{check.detail}</Meta>
          </View>
        </View>
      ))}
      <Meta theme={theme}>Optional steps are only needed for what they say. Refresh at the top checks again.</Meta>
    </>
  );
}

const WORDS = [
  { icon: "Server", term: "Host", text: "A computer or container running a Paseo daemon. Pick which one you're looking at with Paseo's host picker." },
  { icon: "HardDrive", term: "Memory limit", text: "A container can only use so much memory before its processes are stopped by the system. Hosts measures against that limit, not the whole machine." },
  { icon: "Hammer", term: "Heavy job", text: "A build, test run, type check, install or dev server. Several at once compete for the same CPU; your limit is in Settings." },
  { icon: "Flame", term: "Runaway", text: "A process stuck at a full CPU core for minutes, or holding a large share of memory." },
  { icon: "Globe", term: "Browser link", text: "A temporary public web address for one dev server. It works on any device and always expires." },
  { icon: "Laptop", term: "Private forward", text: "Makes a remote dev server answer at 127.0.0.1 on your own computer, over SSH or a paired host. Nothing is published." },
  { icon: "Link", term: "Paired host", text: "Another computer running Paseo and Hosts that you've trusted with a pairing code." },
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

type Question = { icon: string; question: string; answer: readonly string[]; action?: { label: string; tab: TabId; fold?: Fold } };

/** Help's plain questions (0.11.0), each folded; what "What you can do here" and the troubleshooting list used to say. */
export function helpQuestions(minutes: string, shortcuts: boolean): Question[] {
  return [
    {
      icon: "Globe", question: "How do I open my app in a browser?",
      answer: [
        "Start its dev command (such as npm run dev) in that project's terminal in Paseo. It appears under Workspaces with an Open button.",
        `Open makes a temporary web address that works on any device, including your phone, with nothing to install. It lasts ${minutes} and can be extended; anyone with the address can see the app until then. The first time, Hosts asks to set up the link helper once. No account is needed.`,
      ],
      action: { label: "Open Workspaces", tab: "workspaces" },
    },
    {
      icon: "Laptop", question: "Can I open it privately, only on my own computer?",
      answer: [
        "Yes. Pair this host with your own computer once (both need Paseo and Hosts), and its dev servers open at 127.0.0.1 on your computer. Nothing is published.",
        "Already reach this host with SSH keys? Save an SSH forward instead. Both live under Workspaces.",
      ],
      action: { label: "Pair my computer", tab: "workspaces", fold: "private" },
    },
    {
      icon: "SearchX", question: "My dev server isn't listed",
      answer: [
        "It shows only when it runs inside a project registered in Paseo, from that project's folder. A custom server needs a Paseo service script with its port.",
        "Register each project folder on its own: your home folder or the whole disk is too broad and is ignored.",
        "After the daemon restarts, open Hosts on that host once so it can read its projects again. Overview's Setup checks show what's missing.",
      ],
      action: { label: "See setup checks", tab: "overview" },
    },
    {
      icon: "Gauge", question: "This computer feels slow. What's going on?",
      answer: [
        "Open Processes. The heaviest jobs are at the top, with the workspace or dev server that started each one. A job stuck at full CPU, memory near the limit, or too many builds at once are flagged in plain words.",
        "To stop one, select it and press Stop. You see exactly what will stop, children included, before anything happens.",
      ],
      action: { label: "See processes", tab: "processes" },
    },
    {
      icon: "HardDrive", question: "My disk is filling up. What can I clear?",
      answer: [
        "Open Workspaces. It shows how much space is free, what each Paseo workspace uses (biggest first, with whether an agent is working in it) and how much of it is safe to clear. The sidebar dot warns when the disk is 85% full and turns red at 95%.",
        "Hosts clears two things. Build output inside a workspace: installed packages (node_modules), build files (.next, .nuxt, .turbo, dist), test reports and Python caches, and only when git confirms the folder is ignored and holds nothing else. Each one says what clearing it costs, such as \"comes back on the next install (a few minutes)\".",
        "And shared caches, only through each tool's own clean: npm's cache (npm cache clean), pnpm's store (pnpm store prune, which removes only packages no project uses) and Playwright's browsers (playwright uninstall, which removes only browsers no installed Playwright uses). These run only while no install or download is going on.",
        "Everything else is shown by size only: other browser downloads, tool caches and the temporary folder. Hosts doesn't delete them; press Ask an agent beside a temporary folder to have one look at it.",
        "Press Clear on one workspace, or clear every idle workspace at once. You see exactly what goes first, then confirm once.",
        "Checking sizes reads a lot of files, so it runs in the background at low priority, one check at a time, and stops after a few minutes with what it found. Press Refresh at the top to check again.",
      ],
      action: { label: "Open Workspaces", tab: "workspaces" },
    },
    {
      icon: "ShieldBan", question: "What will Hosts never delete?",
      answer: [
        "Anything git tracks or hasn't been told to ignore, a .git folder or any git repository (bare ones too), .env files, your source code, Paseo's own data (settings, history, logs), agents' history (~/.claude and ~/.codex), anything reached through a link, and never a whole workspace or worktree folder. Nothing in the temporary folder, browser download folders or tool caches either: those are shown by size only.",
        "Nothing that's in use: if a program has a file open in it, an agent is working or waiting in that workspace, or a dev server, build, test or install is running there, Hosts leaves it and says why. If Hosts can't see every process completely, it clears nothing. Each folder is checked again just before it goes, and every deletion is logged.",
        "A folder is first moved aside and only then deleted. If Hosts stops halfway, it puts the folder back the next time it starts; if something now sits in its place, the folder is listed under \"Left over from an interrupted clear\" for you or an agent to decide. Hosts never deletes it on its own.",
        "A worktree no workspace uses any more (usually an archived one) shows its size, but Hosts won't remove it: it may hold work that isn't pushed. Ask an agent instead; it checks the worktree and removes it properly with git, after asking you.",
      ],
    },
    {
      icon: "MemoryStick", question: "A job is eating all the memory. What happens?",
      answer: [
        "Hosts checks memory every 10 seconds, even when Paseo is closed. A job using a quarter or more of this computer's memory, or growing fast, is flagged in plain words, for example \"A test run is using 36 GB, 61% of this computer's memory.\" So is memory pressure, when programs start waiting for memory.",
        "Press Stop beside it (it asks first, then forces it after 10 seconds if it won't stop), or Ask an agent to find out why it grew.",
        "If you'd rather Hosts acted on its own, turn on \"Stop a runaway automatically when memory is nearly full\" under Settings → Hosts. It's off by default. When memory has been nearly full for over a minute, it stops the biggest job you could stop by hand, never Paseo, an agent, a terminal's shell or a database, and the sidebar dot tells you.",
      ],
      action: { label: "See processes", tab: "processes" },
    },
    {
      icon: "Puzzle", question: "A plugin isn't answering. What do I do?",
      answer: [
        "When a Paseo plugin stops answering, Paseo can't add, update or reload any plugin until it's sorted. Hosts spots this in Paseo's own log and says which plugin, for example \"Activity isn't answering (12 timeouts in 10 min)\".",
        "Press Restart. It asks first, then reloads just that plugin. If Paseo is stuck on it, Hosts stops only that plugin's own process and reloads it again. Paseo itself, your agents and the other plugins keep running, and every step is logged.",
      ],
      action: { label: "See what needs attention", tab: "overview" },
    },
    {
      icon: "Bot", question: "Can an agent help fix it?",
      answer: [
        "Yes. Beside a runaway process, a dev server that stopped, or a slow or down watched service, press Ask an agent. Pick a chat in that workspace, or start a new one, and read exactly what will be sent first: what's wrong, the figures, the last lines of the dev server's output when Hosts can find them, and a suggested next step.",
        "Passwords, tokens and keys are removed from commands and output before you see the text. A chat that is busy gets it added to what it's doing; it isn't interrupted. The message asks the agent to check with you before stopping or restarting anything.",
        "You can also attach Hosts information to any message yourself: choose Hosts in the message box's attach menu, then heavy processes, what needs attention, a dev server's recent output or a watched service.",
      ],
      action: { label: "See what needs attention", tab: "overview" },
    },
    {
      icon: "ShieldCheck", question: "What can and can't be stopped?",
      answer: [
        "Only processes started from Paseo or running inside your Paseo projects. Paseo itself, its plugins, agents, terminals and databases never can be. Nothing is stopped automatically unless you turn on the memory guard under Settings → Hosts.",
        "A stop asks first, waits a few seconds, and only then forces it. A plugin is never stopped like this; it can only be restarted, and only its own process. Every stop and restart is listed under Processes → Recent stops and restarts.",
      ],
    },
    {
      icon: "FolderSync", question: "How do I copy a project from another computer?",
      answer: [
        "Pair the two computers first. On the one that has the project, allow that pairing to download it. Then, on this one, preview the project and receive it into a new folder.",
        "Only committed Git history is copied (up to 32 MiB). Uncommitted files, chats and Git LFS files are not.",
      ],
      action: { label: "Copy a project", tab: "overview", fold: "sync" },
    },
    {
      icon: "Activity", question: "Can Hosts tell me when a service is slow or down?",
      answer: [
        "Yes. Add its health address under Settings → Hosts → Watched services. Hosts checks it on its schedule; a slow or failing answer turns the sidebar dot amber or red.",
        "When the AI Router plugin is set up here, Overview offers to watch its OmniRoute in one press.",
      ],
    },
    {
      icon: "MessageSquareWarning", question: "What's the small chip under my message box?",
      answer: [
        "It appears only when that chat's workspace needs you: its dev server stopped, a browser link or forward failed, or one of its jobs is slowing the host down. Press it to see the details. A calm chat shows nothing.",
        "Turn it off under Settings → Hosts.",
      ],
    },
    {
      icon: "Zap", question: "Is there a quicker way to check?",
      answer: [
        "The dot beside Hosts in the sidebar is green when all is calm. Press it for a quick check without opening this page.",
        `In the Command Center: Open Hosts, Show heavy processes, and Check host now.${shortcuts ? " In a chat's message box: /hosts opens this workspace's Hosts tab, /heavy-processes shows the heaviest jobs, and /check-host checks now." : ""}`,
      ],
    },
    {
      icon: "WifiOff", question: "A private link won't connect",
      answer: [
        "Both computers must be online with Hosts running. If it still won't connect, use a browser link or your SSH keys instead.",
      ],
      action: { label: "Open private links", tab: "workspaces", fold: "private" },
    },
  ];
}

/**
 * The Help tab: plain questions only, each folded (0.12.1). The walkthrough
 * that used to sit unfolded below them is the first question, "How does
 * Hosts work?".
 */
export function HelpTab({ theme, compact, go, minutes, shortcuts }: { theme: Theme; compact: boolean; go: Go; minutes: string; shortcuts: boolean }) {
  return (
    <Accordion theme={theme}>
      <AccordionItem theme={theme} compact={compact} icon="BookOpen" title="How does Hosts work?" summary="What it watches, what it does about it, and the words it uses">
        <WhatIs theme={theme} />
        <Divider theme={theme} />
        <HowItWorks theme={theme} compact={compact} />
        <Divider theme={theme} />
        <HowToUse theme={theme} go={go} />
        <Divider theme={theme} />
        <Glossary theme={theme} />
      </AccordionItem>
      {helpQuestions(minutes, shortcuts).map((item) => (
        <AccordionItem key={item.question} theme={theme} compact={compact} icon={item.icon} title={item.question}>
          {item.answer.map((line) => <Text key={line} style={{ ...TYPE.body, color: theme.colors.foreground }}>{line}</Text>)}
          {item.action ? <Row><Button theme={theme} label={item.action.label} onPress={() => go(item.action!.tab, item.action!.fold)} /></Row> : null}
        </AccordionItem>
      ))}
    </Accordion>
  );
}
