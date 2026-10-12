import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useState } from "react";
import { Pressable, Text, type TextStyle, type ViewStyle } from "react-native";

import { setBrowserControlTooltip } from "./browser-control-tooltip-web";

type Theme = PluginWorkspacePanelProps["theme"];

export interface ControlButtonStyles {
  button: ViewStyle;
  buttonSelected: ViewStyle;
  buttonPrimary: ViewStyle;
  buttonDanger: ViewStyle;
  buttonHovered: ViewStyle;
  buttonPressed: ViewStyle;
  buttonFocused: ViewStyle;
  buttonDisabled: ViewStyle;
  buttonLarge: ViewStyle;
  buttonFill: ViewStyle;
  buttonPad?: ViewStyle;
  buttonIconOnly?: ViewStyle;
  buttonText: TextStyle;
  buttonTextSelected: TextStyle;
}

interface ControlButtonProps {
  styles: ControlButtonStyles;
  theme: Theme;
  label: string;
  accessibilityLabel?: string;
  icon?: string;
  selected?: boolean;
  primary?: boolean;
  danger?: boolean;
  large?: boolean;
  fill?: boolean;
  pad?: boolean;
  iconOnly?: boolean;
  disabled?: boolean;
  onPress(): void;
}

/** Render the shared control geometry and theme states for browser actions. */
export function ControlButton({
  styles,
  theme,
  label,
  accessibilityLabel,
  icon,
  selected = false,
  primary = false,
  danger = false,
  large = false,
  fill = false,
  pad = false,
  iconOnly = false,
  disabled = false,
  onPress,
}: ControlButtonProps) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const highlighted = selected || primary;
  const tooltipRef = useCallback(
    (node: unknown) => setBrowserControlTooltip(node, accessibilityLabel ?? label),
    [accessibilityLabel, label],
  );
  return (
    <Pressable
      ref={iconOnly ? tooltipRef : undefined}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        iconOnly ? styles.buttonIconOnly : null,
        selected ? styles.buttonSelected : null,
        primary ? styles.buttonPrimary : null,
        danger ? styles.buttonDanger : null,
        hovered && !highlighted ? styles.buttonHovered : null,
        pressed ? styles.buttonPressed : null,
        focused ? styles.buttonFocused : null,
        disabled ? styles.buttonDisabled : null,
        large || pad ? styles.buttonLarge : null,
        fill ? styles.buttonFill : null,
        pad ? styles.buttonPad : null,
      ]}
    >
      {icon ? (
        <Icon
          name={icon}
          size={15}
          color={highlighted ? theme.colors.accentForeground : theme.colors.foregroundMuted}
        />
      ) : null}
      {iconOnly ? null : (
        <Text style={[styles.buttonText, highlighted ? styles.buttonTextSelected : null]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
