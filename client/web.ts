import * as pluginClient from "@getpaseo/plugin/client";
import { Linking, Platform, Share } from "react-native";
import { externalUrlOpener } from "../shared/host-features";

interface ExternalWindow { location: { replace(url: string): void }; close(): void; opener: unknown; }
declare const window: { open(url: string, target: string): ExternalWindow | null } | undefined;
declare const navigator: { clipboard?: { writeText(text: string): Promise<void> } } | undefined;

/**
 * Paseo 0.10+ apps hand plugins `openExternalUrl`, which opens the system
 * browser (on desktop and mobile alike). Older apps get the previous
 * fallbacks: a new tab on the web, `Linking.openURL` elsewhere.
 */
const hostOpen = () => externalUrlOpener(pluginClient);

export async function openExternal(url: string) {
  const open = hostOpen();
  if (open) return open(url);
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const opened = window.open(url, "_blank");
    if (!opened) throw new Error("Your browser blocked the new tab. Allow pop-ups for Paseo and try Open again.");
    opened.opener = null;
  } else await Linking.openURL(url);
}

/**
 * Reserve a tab in the click event, so an asynchronous tunnel startup isn't a
 * blocked popup. Only a plain web page needs the reservation; where the app
 * can open URLs itself, the URL goes to the system browser when it's ready.
 */
export function prepareExternal() {
  const open = hostOpen();
  const reserve = Platform.OS === "web" && typeof window !== "undefined" && !open;
  const opened = reserve ? window!.open("about:blank", "_blank") : null;
  if (reserve && !opened) throw new Error("Allow pop-ups for Paseo to open this service.");
  if (opened) opened.opener = null;
  return {
    async finish(url: string) { if (opened) opened.location.replace(url); else if (open) await open(url); else await Linking.openURL(url); },
    close() { opened?.close(); },
  };
}
