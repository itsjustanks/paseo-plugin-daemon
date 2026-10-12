/** Grouped resolution choices with independent host favorites and capture quality. */
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { BrowserDisplayPreferences } from "../../shared/managed-browser/browser-display-preferences";
import type { DevicePresetId } from "../../shared/managed-browser/device-presets";
import type { ResolutionGroup } from "../../shared/managed-browser/resolution-menu";
import type { CaptureDensityMode } from "./browser-auto-capture-density";
import { BrowserQualityControls } from "./browser-quality-controls";
import { FavoriteStar } from "./favorite-star";

export interface BrowserResolutionPickerProps {
  theme: PluginHostProps["theme"];
  groups: readonly ResolutionGroup[];
  selectedPresetId: DevicePresetId | null;
  fillViewportResolution: { width: number; height: number } | null;
  fillViewportSelected: boolean;
  fillViewportDetail: string;
  onFillViewport(): void;
  favoritePresetIds: readonly DevicePresetId[];
  selectDisabled: boolean;
  favoriteDisabled: boolean;
  density: number;
  densityMode: CaptureDensityMode;
  viewport: { width: number; height: number } | null;
  onDensityChange(value: CaptureDensityMode): void;
  captureQuality: BrowserDisplayPreferences["captureQuality"];
  onSelect(id: DevicePresetId): void;
  onToggleFavorite(id: DevicePresetId): void;
  onQualityChange(quality: BrowserDisplayPreferences["captureQuality"]): void;
}

const STYLES = StyleSheet.create({
  group: { gap: 8 },
  header: { fontSize: 11, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  choice: {
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  title: { flex: 1, fontSize: 13, fontWeight: "600" },
  detail: { fontSize: 11 },
  star: {
    width: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  quality: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
});
/** Keeps star presses outside the resolution button; favoriting never resizes the browser. */
export function BrowserResolutionPicker(props: BrowserResolutionPickerProps) {
  const { theme } = props;
  const colors = theme.colors;
  const selectedStyle = {
    borderColor: colors.accent,
    backgroundColor: colors.surface2,
  };
  const baseStyle = {
    borderColor: colors.border,
    backgroundColor: colors.surface1,
  };
  const fillDisabled = props.selectDisabled || !props.fillViewportResolution;
  return (
    <View style={{ gap: 12 }}>
      <View style={STYLES.group}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Fill viewport, ${props.fillViewportDetail}`}
          accessibilityState={{ disabled: fillDisabled, selected: props.fillViewportSelected }}
          disabled={fillDisabled}
          onPress={props.onFillViewport}
          style={({ pressed }) => [
            STYLES.quality,
            baseStyle,
            props.fillViewportSelected ? selectedStyle : null,
            { opacity: fillDisabled ? 0.45 : pressed ? 0.72 : 1 },
          ]}
        >
          <Icon name="Maximize" size={18} color={colors.foregroundMuted} />
          <Text style={[STYLES.title, { color: colors.foreground }]}>Fill viewport</Text>
        </Pressable>
        <Text style={[STYLES.detail, { color: colors.foregroundMuted }]}>
          {props.fillViewportDetail} · Follow the visible browser area while controlling
        </Text>
      </View>
      {props.groups.map((group) => (
        <View key={group.id} style={STYLES.group}>
          <Text style={[STYLES.header, { color: colors.foregroundMuted }]}>{group.label}</Text>
          {group.presets.map((preset) => {
            const selected = preset.id === props.selectedPresetId;
            const favorite = props.favoritePresetIds.includes(preset.id);
            return (
              <View key={preset.id} style={STYLES.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Emulate ${preset.label}`}
                  accessibilityState={{
                    selected,
                    disabled: props.selectDisabled,
                  }}
                  disabled={props.selectDisabled}
                  onPress={() => props.onSelect(preset.id)}
                  style={({ pressed }) => [
                    STYLES.choice,
                    baseStyle,
                    selected ? selectedStyle : null,
                    {
                      opacity: props.selectDisabled ? 0.45 : pressed ? 0.72 : 1,
                    },
                  ]}
                >
                  <Icon
                    name={preset.isMobile ? "Smartphone" : "Monitor"}
                    size={18}
                    color={selected ? colors.accent : colors.foregroundMuted}
                  />
                  <Text style={[STYLES.title, { color: colors.foreground }]}>{preset.label}</Text>
                  <Text style={[STYLES.detail, { color: colors.foregroundMuted }]}>
                    {preset.viewport.width} × {preset.viewport.height}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${favorite ? "Remove" : "Add"} ${preset.label} ${favorite ? "from" : "to"} favorites`}
                  accessibilityState={{
                    selected: favorite,
                    disabled: props.favoriteDisabled,
                  }}
                  disabled={props.favoriteDisabled}
                  onPress={() => props.onToggleFavorite(preset.id)}
                  style={({ pressed }) => [
                    STYLES.star,
                    {
                      backgroundColor: "transparent",
                      opacity: props.favoriteDisabled ? 0.45 : pressed ? 0.72 : 1,
                    },
                  ]}
                >
                  <FavoriteStar
                    filled={favorite}
                    size={20}
                    color={favorite ? colors.accent : colors.foregroundMuted}
                  />
                </Pressable>
              </View>
            );
          })}
        </View>
      ))}
      <BrowserQualityControls
        theme={theme}
        density={props.density}
        densityMode={props.densityMode}
        viewport={props.viewport}
        densityDisabled={props.selectDisabled}
        onDensityChange={props.onDensityChange}
        disabled={props.favoriteDisabled}
        captureQuality={props.captureQuality}
        onQualityChange={props.onQualityChange}
      />
    </View>
  );
}
