import React, { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View, type ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Meta, RADIUS, SPACE, TYPE } from "./kit";
import type { ResourceSort } from "../shared/resource-table";

export interface ResourceColumn { id: string; label: string; weight?: number; width?: number; sortable?: boolean; compactInline?: boolean; numeric?: boolean }
/** Headers and cells must use the same sizing, including shrink behaviour. */
export function resourceColumnStyle(column: ResourceColumn): ViewStyle {
  return { flexBasis: column.width ?? 0, flexGrow: column.width ? 0 : column.weight ?? 1, flexShrink: column.width ? 0 : 1, minWidth: 0, maxWidth: "100%" };
}
/** Use the table's actual width: Hosts can also live inside a narrow side panel. */
export function ResourceTable({ compact, theme, header, children }: { compact: boolean; theme?: PluginTheme; header?(narrow: boolean): React.ReactNode; children(narrow: boolean): React.ReactNode }) {
  const [width, setWidth] = useState<number | null>(null);
  const narrow = compact || (width !== null && width < 760);
  const heading = header ? <View style={{ backgroundColor: theme?.colors.surface2, paddingHorizontal: SPACE.row }}>{header(narrow)}</View> : null;
  const body = <View style={{ paddingHorizontal: header ? SPACE.row : 0 }}>{children(narrow)}</View>;
  return <View testID="resource-table" onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ minWidth: 0, width: "100%", ...(header && theme ? { borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.control, overflow: "hidden", backgroundColor: theme.colors.surface1 } : {}) }}>
    {header && !narrow ? <ScrollView testID="resource-table-scroll" nestedScrollEnabled stickyHeaderIndices={[0]} style={{ maxHeight: 560, flexGrow: 0 }}>
      {heading}{body}
    </ScrollView> : <>{heading}{body}</>}
  </View>;
}
export function ResourceToolbar({ theme, label, search, onSearch, filters = [], filter = "all", onFilter, children }: {
  theme: PluginTheme; label: string; search: string; onSearch(text: string): void;
  filters?: readonly { id: string; label: string }[]; filter?: string; onFilter?(id: string): void; children?: React.ReactNode;
}) {
  return <View style={{ gap: SPACE.sm, minWidth: 0 }}>
    <TextInput accessibilityLabel={label} value={search} onChangeText={onSearch} maxLength={120} placeholder={label} placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false}
      style={{ ...TYPE.body, minWidth: 0, color: theme.colors.foreground, backgroundColor: theme.colors.surface0, borderColor: theme.colors.border, borderWidth: 1, borderRadius: RADIUS.control, paddingHorizontal: SPACE.row, paddingVertical: SPACE.sm }} />
    {filters.length ? <View accessibilityLabel={`${label} filters`} style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs }}>
      {filters.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Filter: ${item.label}`} accessibilityState={{ selected: item.id === filter }} onPress={() => onFilter?.(item.id)}
        style={{ paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.control, borderWidth: 1, borderColor: item.id === filter ? theme.colors.accent : theme.colors.border }}>
        <Text style={{ ...TYPE.secondary, color: item.id === filter ? theme.colors.accent : theme.colors.foreground }}>{item.label}</Text>
      </Pressable>)}
    </View> : null}
    {children}
  </View>;
}
export function ResourceHeader({ theme, columns, compact, sort, onSort }: { theme: PluginTheme; columns: readonly ResourceColumn[]; compact: boolean; sort: ResourceSort<string>; onSort(id: string): void }) {
  return <View style={{ flexDirection: "row", flexWrap: compact ? "wrap" : "nowrap", gap: SPACE.sm, paddingVertical: SPACE.sm, borderBottomWidth: 1, borderColor: theme.colors.border }}>
    {columns.filter((column) => !compact || column.sortable).map((column) => {
      const active = column.id === sort.id;
      const label = `${column.label}${active ? sort.direction === "desc" ? " ↓" : " ↑" : ""}`;
      const style = compact ? { paddingHorizontal: SPACE.xs } : resourceColumnStyle(column);
      return column.sortable ? <Pressable key={column.id} accessibilityRole="button" accessibilityLabel={`Sort by ${column.label}${active ? `, ${sort.direction === "desc" ? "descending" : "ascending"}` : ""}`} accessibilityHint="Press to change sort direction" onPress={() => onSort(column.id)} style={style}>
        <Text style={{ ...TYPE.secondary, textAlign: !compact && column.numeric ? "right" : "left", color: active ? theme.colors.accent : theme.colors.foregroundMuted }}>{label}</Text>
      </Pressable> : <View key={column.id} style={style}><Meta theme={theme}>{label}</Meta></View>;
    })}
  </View>;
}
export function ResourceCells({ theme, columns, compact, cells }: { theme: PluginTheme; columns: readonly ResourceColumn[]; compact: boolean; cells: Record<string, React.ReactNode> }) {
  return <View style={{ flexDirection: "row", flexWrap: compact ? "wrap" : "nowrap", gap: SPACE.sm, minWidth: 0 }}>
    {columns.map((column) => <View key={column.id} style={{ ...(compact ? { flexBasis: column.compactInline ? "30%" : "100%", flexGrow: column.compactInline ? 1 : 0, flexShrink: 0, minWidth: 0, maxWidth: "100%" } as ViewStyle : resourceColumnStyle(column)), alignItems: !compact && column.numeric ? "flex-end" : "stretch", gap: SPACE.xs }}>
      {compact ? <Meta theme={theme}>{column.label}</Meta> : null}{cells[column.id]}
    </View>)}
  </View>;
}
