/** Local tab selection. Each viewer picks a page without changing another viewer's attachment. */
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { BrowserState, BrowserTab } from "../../shared/managed-browser/browser";
import { ChromeIconButton } from "./browser-chrome";
import type { createStyles } from "./browser-panel-styles";

/** Use the live selected-tab state when available, and the tab snapshot otherwise. */
function controllerSummary(tab: BrowserTab, selectedState: BrowserState | null): string {
  if (selectedState) {
    if (selectedState.controller === "self") return "You control";
    if (selectedState.controller === "other") {
      return `${selectedState.controllerLabel ?? "Another viewer"} controls`;
    }
    return "No controller";
  }
  return tab.controllerLabel ? `${tab.controllerLabel} controls` : "No controller";
}

/** Show compact per-tab presence while keeping control actions on the selected tab only. */
export function BrowserTabs({
  styles,
  theme,
  tabs,
  selectedId,
  selectedState,
  statusColor,
  statusLabel,
  controlAction,
  canCreate,
  canClose,
  onSelect,
  onCreate,
  onClose,
}: {
  styles: ReturnType<typeof createStyles>;
  theme: PluginWorkspacePanelProps["theme"];
  tabs: BrowserTab[];
  selectedId: string | null;
  selectedState: BrowserState | null;
  statusColor: string;
  statusLabel: string;
  controlAction: ReactNode;
  canCreate: boolean;
  canClose: boolean;
  onSelect(id: string): void;
  onCreate(): void;
  onClose(): void;
}) {
  return (
    <View style={styles.tabBar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabList}
        contentContainerStyle={styles.tabListContent}
      >
        {tabs.length === 0 ? <Text style={styles.tabMeta}>Connecting browser…</Text> : null}
        {tabs.map((tab) => {
          const selected = tab.id === selectedId;
          const currentState = selected && selectedState?.tabId === tab.id ? selectedState : null;
          const viewerCount = currentState?.viewerCount ?? tab.viewerCount;
          const controller = controllerSummary(tab, currentState);
          const presence = `${viewerCount} viewer${viewerCount === 1 ? "" : "s"} · ${controller}`;
          return (
            <View key={tab.id} style={[styles.tabItem, selected ? styles.tabItemSelected : null]}>
              <Pressable
                accessibilityRole="tab"
                accessibilityLabel={`${tab.title || tab.url || "New tab"}, ${presence}${selected ? `, ${statusLabel}` : ""}`}
                accessibilityState={{ selected }}
                onPress={() => onSelect(tab.id)}
                style={styles.tabSelect}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.tabLabel, selected ? styles.tabLabelSelected : null]}
                >
                  {tab.title || tab.url || "New tab"}
                </Text>
                <View style={styles.tabMetaRow}>
                  {selected ? (
                    <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                  ) : null}
                  <Text numberOfLines={1} style={styles.tabMeta}>
                    {selected ? controller : presence}
                  </Text>
                </View>
              </Pressable>
              {selected ? (
                <View style={styles.tabActions}>
                  {currentState ? controlAction : null}
                  <ChromeIconButton
                    styles={styles}
                    theme={theme}
                    label="Close selected browser tab"
                    icon="X"
                    disabled={!currentState || !canClose}
                    onPress={onClose}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
      <ChromeIconButton
        styles={styles}
        theme={theme}
        label="New browser tab"
        icon="Plus"
        disabled={!canCreate}
        onPress={onCreate}
      />
    </View>
  );
}
