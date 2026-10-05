import React, { useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Bullets, Disclosure, HostIcon, IconBadge, TYPE, SPACE } from "./kit";


type Theme = PluginTheme;

/**
 * Five tabs, one job each. Icons are Lucide names, drawn by the Paseo app.
 * `title`, `summary` and `canDo` open each tab in plain words, for someone
 * who has never heard of a port or a process. Overview has no intro: its
 * status card is its introduction.
 */
export const TABS = [
  {
    id: "overview", label: "Overview", icon: "LayoutDashboard",
    title: "Overview",
    summary: "Whether this host is healthy right now and what to do next, with a short guide to how Hosts fits together.",
    canDo: ["See at a glance whether memory, CPU and your watched services are fine", "Jump straight to whatever needs attention", "Learn what Hosts does and the words it uses"],
  },
  {
    id: "processes", label: "Processes", icon: "Cpu",
    title: "Heavy processes",
    summary: "What is using this host's CPU and memory right now, which jobs are running away, and a safe way to stop them.",
    canDo: ["See the heaviest processes and which workspace or dev server each belongs to", "See memory against this container's own limit, not just the whole machine", "Spot runaways: a process stuck at full CPU, memory near the limit, too many builds at once", "Stop a job and its children, after a list of exactly what will stop", "See every stop that was made, and when"],
  },
  {
    id: "servers", label: "Dev servers", icon: "Server",
    title: "Dev servers",
    summary: "The dev servers running in your Paseo projects on this host, each with one press to open it in a browser.",
    canDo: ["Open a dev server in your browser through a temporary link", "Reach it privately on your own computer instead (SSH or a paired host)", "Extend or close the links that are open"],
  },
  {
    id: "connect", label: "Connect", icon: "Network",
    title: "Connect to another computer",
    summary: "Ways to reach a dev server on this host from somewhere else: a private link between two Paseo hosts, a public browser link, or an SSH forward.",
    canDo: ["Pair this host with your own computer, so its dev servers open at 127.0.0.1", "Make a temporary browser link that works on any device", "Save SSH forwards that use the keys you already have"],
  },
  {
    id: "sync", label: "Project Sync", icon: "FolderSync",
    title: "Project Sync",
    summary: "Copy a project's Git history from a paired host to this one, after you review what will arrive.",
    canDo: ["Choose which projects a paired host may download", "Preview a project before receiving it", "See what was received, and where it went"],
  },
] as const;
export type TabId = (typeof TABS)[number]["id"];
export const TAB_IDS: readonly TabId[] = TABS.map((tab) => tab.id);

/** About what one tab needs with its label (icon, name, padding); five need ~600 px. */
const LABELLED_TAB_WIDTH = 120;

/**
 * An underline tab bar in one row. When the full labels do not fit (a narrow
 * screen, or a half-width desktop window, measured here), every tab shows its
 * icon and the active tab its label beside it, so nothing is cut off. Without
 * app icons, the labels scroll sideways instead.
 */
export function TabBar({ theme, compact, tabs, active, onSelect }: { theme: Theme; compact: boolean; tabs: readonly TabId[]; active: TabId; onSelect: (id: TabId) => void }) {
  const [width, setWidth] = useState<number | null>(null);
  const tight = compact || (width !== null && width < tabs.length * LABELLED_TAB_WIDTH);
  const iconsOnly = tight && !!HostIcon;
  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next !== width) setWidth(next);
  };
  const items = TABS.filter((tab) => tabs.includes(tab.id)).map((tab) => {
    const selected = tab.id === active;
    const color = selected ? theme.colors.accent : theme.colors.foregroundMuted;
    return (
      <Pressable
        key={tab.id}
        accessibilityRole="tab"
        accessibilityLabel={tab.label}
        accessibilityState={{ selected }}
        onPress={() => onSelect(tab.id)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: SPACE.xs,
          paddingHorizontal: compact ? SPACE.sm : SPACE.row,
          paddingVertical: SPACE.row,
          marginBottom: -1,
          borderBottomWidth: 2,
          borderColor: selected ? theme.colors.accent : "transparent",
          ...(iconsOnly && !selected ? { flexGrow: 1 } : {}),
        }}
      >
        {HostIcon ? <HostIcon name={tab.icon} size={16} color={color} /> : null}
        {!iconsOnly || selected ? <Text numberOfLines={1} style={{ ...TYPE.secondary, color: selected ? theme.colors.accent : theme.colors.foreground, fontWeight: selected ? "700" : "500" }}>{tab.label}</Text> : null}
      </Pressable>
    );
  });
  const bar = { flexDirection: "row" as const, borderBottomWidth: 1, borderColor: theme.colors.border, marginTop: SPACE.row, marginBottom: SPACE.section };
  if (tight && !HostIcon) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" onLayout={onLayout} style={{ ...bar, flexGrow: 0 }}>
        {items}
      </ScrollView>
    );
  }
  return <View accessibilityRole="tablist" onLayout={onLayout} style={bar}>{items}</View>;
}

const INTRO_ICON = 40;

/**
 * The top of each tab: its icon, a clear title and one or two plain sentences
 * on what it is for. "What you can do here" waits behind a small link, so the
 * tab's own content stays near the top. Overview has none: its status card is
 * its introduction.
 */
export function TabIntro({ theme, tab, compact }: { theme: Theme; tab: TabId; compact: boolean }) {
  const item = TABS.find((entry) => entry.id === tab)!;
  return (
    <View style={{ gap: SPACE.sm, marginBottom: SPACE.section }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.row }}>
        <IconBadge theme={theme} name={item.icon} size={INTRO_ICON} />
        <View style={{ flex: 1, gap: SPACE.xs }}>
          <Text accessibilityRole="header" style={{ ...TYPE.tabTitle, color: theme.colors.foreground }}>{item.title}</Text>
          <Text style={{ ...TYPE.lead, color: theme.colors.foreground }}>{item.summary}</Text>
        </View>
      </View>
      <View style={{ paddingLeft: compact ? 0 : INTRO_ICON + SPACE.row }}>
        <Disclosure key={tab} theme={theme} quiet label="What you can do here" openLabel="Hide what you can do here">
          <Bullets theme={theme} items={item.canDo} columns={!compact} />
        </Disclosure>
      </View>
    </View>
  );
}
