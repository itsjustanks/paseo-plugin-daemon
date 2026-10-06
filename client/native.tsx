import React, { type ComponentType, type ReactNode } from "react";
import * as HostUI from "@getpaseo/plugin/client/ui";
import type { PluginClientContext, PluginHostProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { supportsNativeScreens } from "../shared/host-features";

/**
 * Paseo 0.11's screens and sidebar rows, when the app has them; the surface
 * and sidebar item of older apps otherwise. Found at runtime: the 0.8 SDK
 * this plugin builds against does not declare them. The shapes below copy
 * @getpaseo/plugin 0.11.0-beta.3. (The same module as AI Router 0.15.0.)
 */
export type ScreenInput = { screenId: string; params?: Record<string, string> };
export type PopoverProps = { theme: PluginHostProps["theme"]; close(): void; openScreen(input: ScreenInput): void };
type SidebarItemProps = PluginHostProps & {
  currentScreen: { screenId: string; params: Record<string, string> } | null;
  openScreen(input: ScreenInput): void;
  /** 0.11: anchored to the row on wide layouts, a bottom sheet on compact ones. */
  openPopover?: (Content: ComponentType<PopoverProps>) => void;
};
type SidebarRowProps = { icon?: string; label?: string; onPress(): void; active?: boolean; trailing?: ReactNode };
type ScreenProps = PluginSurfaceProps & { params?: Record<string, string> };
type NativeClient = {
  addScreen?: (contribution: { id: string; title: string | ((params: Record<string, string>) => string); Component: ComponentType<ScreenProps> }) => () => void;
  addSidebarHeaderItem?: (contribution: { id: string; title: string; Component: ComponentType<SidebarItemProps> }) => () => void;
};

/** The app's own sidebar row component (0.11+), or null. */
export function hostSidebarRow(): ComponentType<SidebarRowProps> | null {
  const row = (HostUI as unknown as Record<string, unknown>).SidebarRow;
  return typeof row === "function" || (typeof row === "object" && row !== null) ? (row as ComponentType<SidebarRowProps>) : null;
}

/** `Trailing`: drawn at the end of the app's own sidebar row (0.11), such as a status dot that opens a popover. */
export type MainScreen = {
  id: string;
  title: string;
  /** The header title from the screen's params (0.11+), such as "Hosts · Processes"; `title` elsewhere. */
  screenTitle?: (params: Record<string, string>) => string;
  icon: string;
  Component: ComponentType<ScreenProps>;
  Trailing?: ComponentType<{ theme: PluginHostProps["theme"]; openPopover?: SidebarItemProps["openPopover"] }>;
};
export type MainScreenApi = { screen: "screen" | "surface"; sidebar: "row" | "item" };

/**
 * The plugin's main view and its sidebar entry. On a 0.11 app: a screen
 * titled "Hosts" and the app's own sidebar row, highlighted while the screen
 * is open. Otherwise exactly what 0.9 registered.
 */
export function registerMainScreen(client: PluginClientContext, screen: MainScreen): MainScreenApi {
  const native = client as PluginClientContext & NativeClient;
  const Row = hostSidebarRow();
  if (supportsNativeScreens(client, Row)) {
    native.addScreen!({ id: screen.id, title: screen.screenTitle ?? screen.title, Component: screen.Component });
    screenOpener = (params) => (client as unknown as { openScreen(input: ScreenInput): void }).openScreen({ screenId: screen.id, params });
    native.addSidebarHeaderItem!({ id: screen.id, title: screen.title, Component: sidebarEntry(Row!, screen) });
    return { screen: "screen", sidebar: "row" };
  }
  const hasScreens = typeof native.addScreen === "function";
  if (hasScreens) native.addScreen!({ id: screen.id, title: screen.screenTitle ?? screen.title, Component: screen.Component });
  else client.addSurface(screen.id, screen.Component);
  client.addSidebarItem({ id: screen.id, title: screen.title, icon: screen.icon, surface: screen.id });
  return { screen: hasScreens ? "screen" : "surface", sidebar: "item" };
}

function sidebarEntry(Row: ComponentType<SidebarRowProps>, screen: MainScreen): ComponentType<SidebarItemProps> {
  const Trailing = screen.Trailing;
  return function MainScreenSidebarEntry({ theme, currentScreen, openScreen, openPopover }: SidebarItemProps) {
    const trailing = Trailing ? <Trailing theme={theme} openPopover={typeof openPopover === "function" ? openPopover : undefined} /> : undefined;
    return <Row icon={screen.icon} active={currentScreen?.screenId === screen.id} onPress={() => openScreen({ screenId: screen.id })} trailing={trailing} />;
  };
}

let screenOpener: ((params: Record<string, string>) => void) | null = null;

/**
 * Reopens the Hosts screen with new params (0.12.1), so the app's header
 * title follows the tab ("Hosts · Processes") and back/forward keep the
 * place, as Memories does. False where the app has no native screens.
 */
export function syncScreenParams(next: Record<string, string>, current: Record<string, string> | undefined): boolean {
  if (!screenOpener || current === undefined) return false;
  const key = (params: Record<string, string>) => JSON.stringify(Object.keys(params).sort().map((name) => [name, params[name]]));
  if (key(next) !== key(current)) screenOpener(next);
  return true;
}

/** Opens a screen (with params) with `openScreen` on a 0.11 app, `openSurface` before. */
export function openMainScreen(capabilities: { openSurface(id: string): void; openScreen?: unknown }, id: string, params?: Record<string, string>): void {
  if (typeof capabilities.openScreen === "function") (capabilities as { openScreen(input: ScreenInput): void }).openScreen({ screenId: id, ...(params ? { params } : {}) });
  else capabilities.openSurface(id);
}
