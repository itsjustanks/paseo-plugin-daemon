import { Linking, Platform, Share } from "react-native";

interface ExternalWindow { location: { replace(url: string): void }; close(): void; opener: unknown; }
declare const window: { open(url: string, target: string): ExternalWindow | null } | undefined;
declare const navigator: { clipboard?: { writeText(text: string): Promise<void> } } | undefined;

export async function sharePairingCode(text: string) {
  if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) await navigator.clipboard.writeText(text);
  else if (Platform.OS !== "web") await Share.share({ message: text });
  else throw new Error("Select the pairing code and copy it from the text below.");
}

export async function openExternal(url: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const opened = window.open(url, "_blank");
    if (!opened) throw new Error("Your browser blocked the new tab. Allow pop-ups for Paseo and try Open again.");
    opened.opener = null;
  } else await Linking.openURL(url);
}

/** Reserve a tab in the click event, so an asynchronous tunnel startup isn't a blocked popup. */
export function prepareExternal() {
  const opened = Platform.OS === "web" && typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
  if (Platform.OS === "web" && !opened) throw new Error("Allow pop-ups for Paseo to open this service.");
  if (opened) opened.opener = null;
  return {
    async finish(url: string) { if (opened) opened.location.replace(url); else await Linking.openURL(url); },
    close() { opened?.close(); },
  };
}
