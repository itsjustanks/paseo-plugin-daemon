import React, { useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { TAB_IDS, type TabId } from "../shared/tabs";
import { HostIcon, TYPE, SPACE, RADIUS } from "./kit";


type Theme = PluginTheme;

/**
 * Four tabs, by what someone comes to do (0.11.0): is this computer fine
 * (Overview), what is making it slow (Processes), open my app (Dev servers),
 * how does this work (Help). Connect and Project Sync fold out under Dev
 * servers; old links to them land there (`shared/tabs.ts`). Icons are Lucide
 * names, drawn by the Paseo app. `line` is the tab's one plain sentence, if
 * it needs one; Overview's status card and Help's questions speak for
 * themselves.
 */
export const TABS: ReadonlyArray<{ id: TabId; label: string; icon: string; line?: string }> = [
  { id: "overview", label: "Overview", icon: "LayoutDashboard" },
  { id: "processes", label: "Processes", icon: "Cpu", line: "Find what is using memory and CPU. Review jobs, browsers and Housekeeping." },
  { id: "workspaces", label: "Workspaces", icon: "FolderTree", line: "Your Paseo workspaces: what's running in each, what each uses on disk, and what's safe to clear." },
  { id: "help", label: "Help", icon: "CircleHelp" },
];
export { TAB_IDS, type TabId };

/** About what one tab needs with its label (icon, name, padding); four need ~480 px. */
const LABELLED_TAB_WIDTH = 120;

/** Keep labels readable; narrow navigation scrolls horizontally when needed. */
export function TabBar({ theme, compact, tabs, active, onSelect }: { theme: Theme; compact: boolean; tabs: readonly TabId[]; active: TabId; onSelect: (id: TabId) => void }) {
  const [width, setWidth] = useState<number | null>(null);
  const tight = compact || (width !== null && width < tabs.length * LABELLED_TAB_WIDTH);
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
        {...({ "aria-selected": selected } as object)}
        onPress={() => onSelect(tab.id)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: SPACE.xs,
          paddingHorizontal: tight ? SPACE.sm : SPACE.row,
          paddingVertical: SPACE.row,
          marginBottom: -1,
          borderBottomWidth: 2,
          borderColor: selected ? theme.colors.accent : "transparent",
          ...(tight ? { flexShrink: 0 } : {}),
        }}
      >
        {HostIcon && !tight ? <HostIcon name={tab.icon} size={16} color={color} /> : null}
        <Text numberOfLines={1} style={{ ...TYPE.secondary, color: selected ? theme.colors.accent : theme.colors.foreground, fontWeight: selected ? "700" : "500" }}>{tab.label}</Text>
      </Pressable>
    );
  });
  const bar = { flexDirection: "row" as const, borderBottomWidth: 1, borderColor: theme.colors.border, marginTop: SPACE.row, marginBottom: SPACE.section };
  if (tight) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator accessibilityRole="tablist" accessibilityLabel="Hosts navigation" onLayout={onLayout} style={{ ...bar, flexGrow: 0 }}>
        {items}
      </ScrollView>
    );
  }
  return <View accessibilityRole="tablist" accessibilityLabel="Hosts navigation" onLayout={onLayout} style={bar}>{items}</View>;
}

/** A tab's one plain sentence, under the tab bar; nothing when the tab has none. */
export function TabLine({ theme, tab }: { theme: Theme; tab: TabId }) {
  const line = TABS.find((entry) => entry.id === tab)?.line;
  if (!line) return null;
  return <Text style={{ ...TYPE.body, color: theme.colors.foreground, marginBottom: SPACE.section }}>{line}</Text>;
}

export const PROCESS_PIVOTS = [
  { id: "all", label: "All processes" },
  { id: "jobs", label: "Heavy jobs" },
  { id: "browsers", label: "Browsers" },
  { id: "housekeeping", label: "Housekeeping" },
] as const;
export type ProcessPivot = typeof PROCESS_PIVOTS[number]["id"];

/** Keep every destination named, including in a narrow workspace panel. */
export function ProcessPivotBar({ theme, active, onSelect }: { theme: Theme; active: ProcessPivot; onSelect(id: ProcessPivot): void }) {
  return <View accessibilityRole="tablist" accessibilityLabel="Process views" style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs, marginBottom: SPACE.row }}>
    {PROCESS_PIVOTS.map(({ id, label }) => <Pressable key={id} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: active === id }} onPress={() => onSelect(id)}
      style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: SPACE.row, paddingVertical: SPACE.sm, borderRadius: RADIUS.control, borderWidth: 1, borderColor: active === id ? theme.colors.accent : theme.colors.border, backgroundColor: active === id ? theme.colors.surface2 : theme.colors.surface1 }}>
      <Text style={{ ...TYPE.secondary, color: active === id ? theme.colors.accent : theme.colors.foreground, fontWeight: active === id ? "600" : "400" }}>{label}</Text>
    </Pressable>)}
  </View>;
}
