/** Public themed panel controls and notices. Leaves own only focus/hover styling, never browser authority. */
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  Text,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { ControlButton, type ControlButtonStyles } from "./browser-control-button";
import { setBrowserControlTooltip } from "./browser-control-tooltip-web";
import { DIMENSION } from "./browser-panel-styles";

type Theme = PluginWorkspacePanelProps["theme"];

export { ControlButton } from "./browser-control-button";

interface FieldStyles {
  field: TextStyle;
  fieldFocused: TextStyle;
  fieldDisabled: TextStyle;
}

interface ErrorNoticeStyles extends ControlButtonStyles {
  errorRow: ViewStyle;
  errorText: TextStyle;
}

interface CanvasPlaceholderStyles {
  canvasState: ViewStyle;
  canvasTitle: TextStyle;
  canvasDetail: TextStyle;
}

interface ChromeIconButtonStyles {
  chromeIconButton: ViewStyle;
  chromeIconButtonHovered: ViewStyle;
  chromeIconButtonPressed: ViewStyle;
  chromeIconButtonDisabled: ViewStyle;
}

/** Themed button leaf using public SDK/RN primitives. */
export function ChromeIconButton({
  styles,
  theme,
  label,
  icon,
  iconNode,
  selected = false,
  expanded,
  disabled = false,
  onPress,
}: {
  styles: ChromeIconButtonStyles;
  theme: Theme;
  label: string;
  icon: string;
  iconNode?: ReactNode;
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const tooltipRef = useCallback((node: unknown) => setBrowserControlTooltip(node, label), [label]);
  return (
    <Pressable
      ref={tooltipRef}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected, ...(expanded === undefined ? {} : { expanded }) }}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chromeIconButton,
        hovered ? styles.chromeIconButtonHovered : null,
        pressed ? styles.chromeIconButtonPressed : null,
        disabled ? styles.chromeIconButtonDisabled : null,
      ]}
    >
      {iconNode ?? (
        <Icon
          name={icon}
          size={16}
          color={selected ? theme.colors.accent : theme.colors.foregroundMuted}
        />
      )}
    </Pressable>
  );
}

interface FieldProps {
  styles: FieldStyles;
  theme: Theme;
  value: string;
  accessibilityLabel: string;
  placeholder?: string;
  editable?: boolean;
  /** Read-only information can stay legible without implying it is editable. */
  dimWhenReadOnly?: boolean;
  maxLength?: number;
  keyboardType?: TextInputProps["keyboardType"];
  inputMode?: TextInputProps["inputMode"];
  returnKeyType?: TextInputProps["returnKeyType"];
  selectTextOnFocus?: boolean;
  style?: StyleProp<TextStyle>;
  onChangeText(value: string): void;
  onSubmit?(): void;
  onFocus?(): void;
  onBlur?(): void;
}

/** Themed panel field leaf using public SDK/RN primitives. */
export function Field({
  styles,
  theme,
  value,
  accessibilityLabel,
  placeholder,
  editable = true,
  dimWhenReadOnly = true,
  maxLength,
  keyboardType,
  inputMode,
  returnKeyType,
  selectTextOnFocus,
  style,
  onChangeText,
  onSubmit,
  onFocus,
  onBlur,
}: FieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      editable={editable}
      keyboardType={keyboardType}
      inputMode={inputMode}
      maxLength={maxLength}
      onBlur={() => {
        setFocused(false);
        onBlur?.();
      }}
      onChangeText={onChangeText}
      onFocus={() => {
        setFocused(true);
        onFocus?.();
      }}
      onSubmitEditing={onSubmit}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      returnKeyType={returnKeyType}
      selectionColor={theme.colors.accent}
      selectTextOnFocus={selectTextOnFocus}
      style={[
        styles.field,
        style,
        focused ? styles.fieldFocused : null,
        !editable && dimWhenReadOnly ? styles.fieldDisabled : null,
      ]}
      value={value}
    />
  );
}

/** Themed panel errornotice leaf using public SDK/RN primitives. */
export function ErrorNotice({
  styles,
  theme,
  message,
  action,
  onAction,
  actionDisabled = false,
}: {
  styles: ErrorNoticeStyles;
  theme: Theme;
  message: string;
  action?: string | undefined;
  onAction?: (() => void) | undefined;
  actionDisabled?: boolean;
}) {
  return (
    <View accessibilityRole="alert" style={styles.errorRow}>
      <Icon name="CircleAlert" size={DIMENSION.icon} color={theme.colors.statusDanger} />
      <Text style={styles.errorText}>{message}</Text>
      {action && onAction ? (
        <ControlButton
          styles={styles}
          theme={theme}
          label={action}
          disabled={actionDisabled}
          onPress={onAction}
        />
      ) : null}
    </View>
  );
}

/** Themed panel canvasplaceholder leaf using public SDK/RN primitives. */
export function CanvasPlaceholder({
  styles,
  theme,
  title,
  detail,
  loading = false,
  children,
}: {
  styles: CanvasPlaceholderStyles;
  theme: Theme;
  title: string;
  detail: string;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <View style={styles.canvasState}>
      {loading ? <ActivityIndicator color={theme.colors.accent} /> : null}
      <Text style={styles.canvasTitle}>{title}</Text>
      <Text style={styles.canvasDetail}>{detail}</Text>
      {children}
    </View>
  );
}
