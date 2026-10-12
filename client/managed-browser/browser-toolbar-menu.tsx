/**
 * One anchored menu surface for workspace-panel toolbar controls. The public SDK
 * has no inline menu, so use its theme and public RN primitives without importing
 * host internals. Placement stays inside the pane, including compact clients.
 */
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { browserMenuPlacement, type MenuRect } from "./browser-menu-placement";
import { bindBrowserToolbarMenuWeb, focusBrowserMenuTrigger } from "./browser-toolbar-menu-web";
import { type BrowserSubmenu, BrowserToolbarSubmenu } from "./browser-toolbar-submenu";

type Theme = PluginHostProps["theme"];
const STYLES = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 100 },
  menu: { position: "absolute", borderWidth: 1, borderRadius: 8, overflow: "hidden", elevation: 8 },
  content: { paddingVertical: 4 },
  item: {
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  label: { fontSize: 13, flexShrink: 1, flex: 1 },
  heading: {
    fontSize: 11,
    fontWeight: "600",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  separator: { borderBottomWidth: 1, marginVertical: 4 },
});

export interface BrowserToolbarMenuProps {
  theme: Theme;
  title: string;
  compact: boolean;
  paneRef: RefObject<View | null>;
  anchorRef: RefObject<View | null>;
  paneSize: { width: number; height: number };
  /** Estimated body height; overflow remains scrollable instead of growing outside the pane. */
  preferredHeight: number;
  onClose(): void;
  shouldRestoreFocus(): boolean;
  children: ReactNode;
  submenu?: BrowserSubmenu | undefined;
  onSubmenuOpen?(): void;
}

/** Measure after layout, reject obsolete callbacks, and re-anchor on pane resizing. */
export function BrowserToolbarMenu(props: BrowserToolbarMenuProps) {
  const compact = props.compact || Platform.OS !== "web";
  const previousSubmenu = useRef<BrowserSubmenu | undefined>(undefined);
  const [placement, setPlacement] = useState<MenuRect | null>(null);
  const menuRef = useRef<View | null>(null);
  const overlayRef = useRef<View | null>(null);
  const current = useRef(props);
  current.current = props;
  useLayoutEffect(() => {
    let active = true;
    props.paneRef.current?.measureInWindow((paneX, paneY) => {
      if (!active) return;
      props.anchorRef.current?.measureInWindow((x, y, width, height) => {
        if (!active) return;
        setPlacement(
          browserMenuPlacement(
            props.paneSize,
            { x: x - paneX, y: y - paneY, width, height },
            compact && props.submenu ? props.submenu.preferredHeight + 52 : props.preferredHeight,
          ),
        );
      });
    });
    return () => {
      active = false;
    };
  }, [
    props.paneRef,
    props.anchorRef,
    props.paneSize.width,
    props.paneSize.height,
    props.preferredHeight,
    compact,
    Boolean(props.submenu),
  ]);

  useEffect(() => {
    if (!placement) return;
    const dispose = bindBrowserToolbarMenuWeb(
      menuRef.current,
      props.anchorRef.current,
      () => current.current.onClose(),
      () => current.current.shouldRestoreFocus(),
      overlayRef.current,
      {
        openSubmenu: () => current.current.onSubmenuOpen?.(),
        ...(compact && props.submenu ? { back: () => current.current.submenu?.onBack() } : {}),
      },
    );
    if (compact && previousSubmenu.current && !props.submenu) {
      focusBrowserMenuTrigger(previousSubmenu.current.anchorRef.current);
    }
    previousSubmenu.current = props.submenu;
    return dispose;
  }, [Boolean(placement), props.anchorRef, compact, compact && Boolean(props.submenu)]);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (current.current.submenu) current.current.submenu.onBack();
      else current.current.onClose();
      return true;
    });
    return () => subscription.remove();
  }, []);

  return (
    <View ref={overlayRef} style={STYLES.overlay} accessibilityViewIsModal>
      <Pressable
        accessible={false}
        focusable={false}
        accessibilityLabel={`Close ${props.title}`}
        style={StyleSheet.absoluteFillObject}
        onPress={props.onClose}
      />
      {placement ? (
        <View
          ref={menuRef}
          accessibilityRole="menu"
          accessibilityLabel={props.title}
          onAccessibilityEscape={compact && props.submenu ? props.submenu.onBack : props.onClose}
          style={[
            STYLES.menu,
            { overflow: "visible" },
            {
              left: placement.x,
              top: placement.y,
              width: placement.width,
              maxHeight: placement.height,
              borderColor: props.theme.colors.border,
              backgroundColor: props.theme.colors.surface1,
            },
          ]}
        >
          <ScrollView
            style={{ maxHeight: placement.height - 2, borderRadius: 8, overflow: "hidden" }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={STYLES.content}
          >
            {compact && props.submenu ? (
              <>
                <BrowserMenuItem
                  theme={props.theme}
                  compact
                  label="Back"
                  icon="ChevronLeft"
                  onPress={props.submenu.onBack}
                />
                <BrowserMenuHeading theme={props.theme}>{props.submenu.title}</BrowserMenuHeading>
                {props.submenu.children}
              </>
            ) : (
              props.children
            )}
          </ScrollView>
          {!compact && props.submenu ? (
            <BrowserToolbarSubmenu
              theme={props.theme}
              submenu={props.submenu}
              paneRef={props.paneRef}
              paneSize={props.paneSize}
              parent={placement}
              onClose={props.onClose}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Standard menu row; checked choices use an indicator instead of a raised action button. */
export function BrowserMenuItem({
  theme,
  compact,
  label,
  icon,
  selected,
  disabled = false,
  expanded,
  onPress,
}: {
  theme: Theme;
  compact: boolean;
  label: string;
  icon?: string;
  selected?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      accessibilityState={{
        disabled,
        ...(expanded === undefined ? {} : { expanded }),
        ...(selected === undefined ? {} : { selected }),
      }}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      style={({ pressed }) => [
        STYLES.item,
        {
          minHeight: compact ? 44 : 36,
          backgroundColor: hovered || focused ? theme.colors.surface2 : "transparent",
          opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
        },
      ]}
    >
      {icon ? <Icon name={icon} size={16} color={theme.colors.foregroundMuted} /> : null}
      <Text style={[STYLES.label, { color: theme.colors.foreground }]}>{label}</Text>
      {expanded !== undefined ? (
        <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} />
      ) : null}
      {selected ? <Icon name="Check" size={16} color={theme.colors.accent} /> : null}
    </Pressable>
  );
}

/** Group labels and separators share the same themed menu chrome. */
export function BrowserMenuHeading({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <Text style={[STYLES.heading, { color: theme.colors.foregroundMuted }]}>{children}</Text>;
}

export function BrowserMenuSeparator({ theme }: { theme: Theme }) {
  return <View style={[STYLES.separator, { borderBottomColor: theme.colors.border }]} />;
}
