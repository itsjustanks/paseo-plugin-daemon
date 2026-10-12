/** Own themed panel spacing and styles; geometry/input policy lives in the panel and canvas modules. */
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { StyleSheet } from "react-native";

type Theme = PluginWorkspacePanelProps["theme"];

export const SPACE = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
} as const;
const RADIUS = { sm: 6, md: 8, lg: 10 } as const;
const TYPE = { caption: 11, body: 13, title: 14 } as const;
export const DIMENSION = {
  control: 34,
  touch: 44,
  icon: 15,
  addressRegular: 220,
  canvasCompact: 220,
  canvasRegular: 320,
  helperMax: 420,
  viewportField: 72,
  screenRadius: 20,
} as const;
/** Build stable theme/compact styles without changing shared browser state. */
export function createStyles(theme: Theme, compact: boolean) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      minHeight: 0,
      backgroundColor: theme.colors.surface0,
    },
    tabBar: {
      minHeight: DIMENSION.touch,
      paddingHorizontal: SPACE.sm,
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    tabList: {
      flex: 1,
      minWidth: 0,
    },
    tabListContent: {
      alignItems: "center",
      gap: SPACE.xs,
    },
    tabItem: {
      minHeight: DIMENSION.touch,
      width: compact ? 132 : 176,
      flexDirection: "row",
      alignItems: "center",
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
    },
    tabItemSelected: {
      width: compact ? 300 : 380,
      borderBottomColor: theme.colors.accent,
    },
    tabSelect: {
      flex: 1,
      minWidth: 0,
      paddingHorizontal: SPACE.sm,
      paddingVertical: SPACE.xxs,
      justifyContent: "center",
    },
    tabMetaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
    },
    tabMeta: {
      flexShrink: 1,
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
    },
    tabActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xxs,
      paddingRight: SPACE.xs,
    },
    tabLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.body,
    },
    tabLabelSelected: {
      color: theme.colors.foreground,
      fontWeight: "600",
    },
    statusDot: {
      width: SPACE.sm,
      height: SPACE.sm,
      borderRadius: RADIUS.sm,
    },
    mutedText: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
    },
    chrome: {
      minHeight: 40,
      paddingHorizontal: SPACE.sm,
      paddingVertical: SPACE.xs,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    addressRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
    },
    addressInput: {
      flex: 1,
      minWidth: compact ? 40 : DIMENSION.addressRegular,
    },
    chromeAddressInput: {
      height: compact ? 44 : 28,
      borderRadius: RADIUS.md,
      backgroundColor: theme.colors.surface1,
      // Compact chrome must override the themed input's form-sized padding.
      // Keep a full text line even on native hosts with their own font padding.
      paddingVertical: 0,
      paddingHorizontal: SPACE.xs,
      fontSize: TYPE.body,
      lineHeight: 18,
      includeFontPadding: false,
      textAlignVertical: "center",
    },
    chromeIconButton: {
      width: compact ? 44 : 32,
      height: compact ? 44 : 32,
      borderRadius: RADIUS.md,
      alignItems: "center",
      justifyContent: "center",
    },
    chromeIconButtonHovered: {
      backgroundColor: theme.colors.surface2,
    },
    chromeIconButtonPressed: {
      opacity: 0.72,
    },
    chromeIconButtonDisabled: {
      opacity: 0.45,
    },

    button: {
      minHeight: compact ? DIMENSION.touch : DIMENSION.control,
      minWidth: compact ? DIMENSION.touch : DIMENSION.control,
      paddingHorizontal: SPACE.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: RADIUS.sm,
      backgroundColor: theme.colors.surface2,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: SPACE.xs,
    },
    buttonIconOnly: {
      width: compact ? DIMENSION.touch : DIMENSION.control,
      minWidth: compact ? DIMENSION.touch : DIMENSION.control,
      paddingHorizontal: 0,
    },
    buttonSelected: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accent,
    },
    buttonPrimary: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.accent,
    },
    buttonDanger: {
      borderColor: theme.colors.statusWarning,
    },
    buttonHovered: {
      borderColor: theme.colors.foregroundMuted,
    },
    buttonPressed: {
      opacity: 0.72,
    },
    buttonFocused: {
      borderColor: theme.colors.accent,
      borderWidth: 2,
    },
    buttonDisabled: {
      opacity: 0.42,
    },
    buttonText: {
      color: theme.colors.foreground,
      fontSize: TYPE.caption,
      fontWeight: "600",
    },
    buttonTextSelected: {
      color: theme.colors.accentForeground,
    },
    field: {
      height: DIMENSION.control,
      paddingHorizontal: SPACE.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: RADIUS.sm,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      fontSize: TYPE.body,
    },
    fieldFocused: {
      borderColor: theme.colors.accent,
      borderWidth: 2,
    },
    fieldDisabled: {
      opacity: 0.5,
    },
    errorRow: {
      paddingHorizontal: SPACE.sm,
      paddingVertical: SPACE.xs,
      borderLeftWidth: SPACE.xs,
      borderLeftColor: theme.colors.statusDanger,
      backgroundColor: theme.colors.surface1,
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
    },
    errorText: {
      flex: 1,
      color: theme.colors.statusDanger,
      fontSize: TYPE.caption,
    },
    canvasShell: {
      flex: 1,
      minHeight: 0,
      minWidth: 0,
      // Keep the compact side inset without adding blank bands above and below the feed.
      marginHorizontal: 0,
      borderRadius: 0,
      overflow: "hidden",
      backgroundColor: theme.colors.surface1,
    },
    canvas: {
      flex: 1,
      minHeight: 0,
      overflow: "hidden",
    },
    interactionLayer: {
      position: "absolute",
    },
    canvasState: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: SPACE.lg,
      gap: SPACE.sm,
    },
    canvasTitle: {
      color: theme.colors.foreground,
      fontSize: TYPE.title,
      fontWeight: "600",
      textAlign: "center",
    },
    canvasDetail: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
      textAlign: "center",
      maxWidth: DIMENSION.helperMax,
    },
    canvasFooter: {
      minHeight: compact ? DIMENSION.touch : DIMENSION.control,
      paddingHorizontal: SPACE.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: SPACE.sm,
      backgroundColor: theme.colors.surface1,
    },
    canvasFooterText: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
      flexShrink: 1,
    },

    mobileRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
    },
    sheetContent: {
      gap: SPACE.md,
      padding: SPACE.sm,
    },
    sheetGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: SPACE.sm,
    },
    controlStrip: {
      minHeight: compact ? DIMENSION.touch : DIMENSION.control,
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
    },
    dialogBody: {
      gap: SPACE.md,
      paddingBottom: SPACE.xs,
    },
    dialogMessage: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.body,
      lineHeight: 20,
      textAlign: "left",
    },
    dialogActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      alignItems: "center",
      gap: SPACE.sm,
      paddingTop: SPACE.xs,
    },
    stripLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
      fontWeight: "600",
      marginRight: SPACE.xs,
    },
    viewportField: {
      width: DIMENSION.viewportField,
      textAlign: "center",
    },
    multiply: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.body,
    },

    deviceModalContent: {
      gap: SPACE.sm,
      padding: SPACE.sm,
    },
    devicePresetRow: {
      minHeight: 46,
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: RADIUS.md,
      backgroundColor: theme.colors.surface1,
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
    },
    devicePresetRowSelected: {
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.surface2,
    },
    devicePresetText: {
      flex: 1,
      color: theme.colors.foreground,
      fontSize: TYPE.body,
      fontWeight: "600",
    },
    devicePresetDetail: {
      color: theme.colors.foregroundMuted,
      fontSize: TYPE.caption,
    },
    customViewportRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
    },
    buttonLarge: {
      minHeight: DIMENSION.touch,
      paddingHorizontal: SPACE.md,
      borderRadius: RADIUS.md,
    },
    buttonFill: {
      flex: 1,
    },
  });
}
