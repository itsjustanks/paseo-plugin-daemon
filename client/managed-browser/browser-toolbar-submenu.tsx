/** Desktop flyouts remain descendants of the root menu and share its one backdrop. */
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { browserSubmenuPlacement, type MenuRect } from "./browser-menu-placement";
import { bindBrowserToolbarMenuWeb } from "./browser-toolbar-menu-web";

export interface BrowserSubmenu {
  title: string;
  anchorRef: RefObject<View | null>;
  preferredHeight: number;
  children: ReactNode;
  onBack(): void;
}

/** Measure the actual trigger row; refuse obsolete callbacks after close/resize. */
export function BrowserToolbarSubmenu(props: {
  theme: PluginHostProps["theme"];
  submenu: BrowserSubmenu;
  paneRef: RefObject<View | null>;
  paneSize: { width: number; height: number };
  parent: MenuRect;
  onClose(): void;
}) {
  const [placement, setPlacement] = useState<MenuRect | null>(null);
  const menu = useRef<View | null>(null);
  const current = useRef(props);
  current.current = props;
  useLayoutEffect(() => {
    let active = true;
    props.paneRef.current?.measureInWindow((paneX, paneY) => {
      props.submenu.anchorRef.current?.measureInWindow((x, y, width, height) => {
        if (!active) return;
        setPlacement(
          browserSubmenuPlacement(
            props.paneSize,
            props.parent,
            { x: x - paneX, y: y - paneY, width, height },
            props.submenu.preferredHeight,
          ),
        );
      });
    });
    return () => {
      active = false;
    };
  }, [props.paneSize.width, props.paneSize.height, props.parent, props.submenu.anchorRef]);
  useLayoutEffect(() => {
    if (!placement) return;
    return bindBrowserToolbarMenuWeb(
      menu.current,
      props.submenu.anchorRef.current,
      () => current.current.submenu.onBack(),
      () => true,
      undefined,
      {
        nested: true,
        back: () => current.current.submenu.onBack(),
        closeRoot: () => current.current.onClose(),
      },
    );
  }, [Boolean(placement), props.submenu.anchorRef]);
  if (!placement) return null;
  return (
    <View
      ref={menu}
      accessibilityRole="menu"
      accessibilityLabel={props.submenu.title}
      onAccessibilityEscape={props.submenu.onBack}
      style={{
        position: "absolute",
        left: placement.x - props.parent.x,
        top: placement.y - props.parent.y,
        width: placement.width,
        maxHeight: placement.height,
        borderWidth: 1,
        borderRadius: 8,
        overflow: "hidden",
        backgroundColor: props.theme.colors.surface1,
        borderColor: props.theme.colors.border,
        elevation: 9,
      }}
    >
      <ScrollView
        style={{ maxHeight: placement.height - 2 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingVertical: 4 }}
      >
        {props.submenu.children}
      </ScrollView>
    </View>
  );
}
