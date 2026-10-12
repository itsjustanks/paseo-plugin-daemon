/** Controller-only physical capture density, independent of CSS resolution and emulation. */
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { canUseCaptureDensity } from "../../shared/managed-browser/browser";
import { MAX_VIEWPORT } from "../../shared/managed-browser/viewport-limits";
import type { CaptureDensityMode } from "./browser-auto-capture-density";

interface Props {
  theme: PluginHostProps["theme"];
  density: number;
  mode: CaptureDensityMode;
  viewport: { width: number; height: number } | null;
  disabled: boolean;
  onChange(value: CaptureDensityMode): void;
}
const styles = StyleSheet.create({
  group: { gap: 8 },
  heading: { fontSize: 11, fontWeight: "600" },
  choice: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 8 },
  label: { fontSize: 13, fontWeight: "600" },
  detail: { fontSize: 11 },
});

/** Selection reflects actual state, including a preset whose density was changed independently. */
export function BrowserCaptureDensityControls(props: Props) {
  const colors = props.theme.colors;
  return (
    <View style={styles.group}>
      <Text style={[styles.heading, { color: colors.foregroundMuted }]}>Capture density</Text>
      {(["auto", 1, 2] as const).map((density) => {
        const supported =
          props.viewport !== null &&
          (density === "auto" || canUseCaptureDensity(props.viewport, density));
        const disabled = props.disabled || !supported;
        const selected = props.mode === density;
        let label = `${density}×`;
        if (density === "auto") {
          label = selected ? `Auto (${props.density}×)` : "Auto";
        }
        return (
          <Pressable
            key={density}
            accessibilityRole="button"
            accessibilityLabel={`Capture density: ${label}`}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => {
              if (!disabled) props.onChange(density);
            }}
            style={({ pressed }) => [
              styles.choice,
              {
                borderColor: selected ? colors.accent : colors.border,
                backgroundColor: selected ? colors.surface2 : colors.surface1,
                opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
              },
            ]}
          >
            <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
          </Pressable>
        );
      })}
      <Text style={[styles.detail, { color: colors.foregroundMuted }]}>
        Auto matches the displayed size and screen density up to 2× while controlling. Higher
        density uses more bandwidth.
      </Text>
      {props.viewport && !canUseCaptureDensity(props.viewport, 2) ? (
        <Text style={[styles.detail, { color: colors.foregroundMuted }]}>
          2× requires a page width of {Math.floor(MAX_VIEWPORT.width / 2)} or less and a height of{" "}
          {Math.floor(MAX_VIEWPORT.height / 2)} or less.
        </Text>
      ) : null}
    </View>
  );
}
