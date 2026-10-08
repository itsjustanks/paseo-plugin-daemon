import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Clipboard, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import * as HostRN from "@getpaseo/plugin/client/react-native";
import { redactSecrets } from "../shared/redaction";
import { Button, Note, Row, SPACE, TYPE, type Tone } from "./kit";

/**
 * Paseo's own toasts, clipboard and dialogs (0.15.0), looked up at runtime so
 * an app without them keeps what Hosts did before: the message bar at the top
 * of the page, react-native's clipboard, and the question asked in place.
 * Every word passes the shared redactor first (shared/redaction.ts).
 */

export type Message = { text: string; tone: Tone } | null;
type ToastVariant = "default" | "info" | "success" | "warning" | "error";
export type ToastApi = { show(message: string, options?: { variant?: ToastVariant; durationMs?: number }): void; error(message: string): void };
type ModalComponent = ComponentType<{ title: string; icon?: ReactNode; open: boolean; onOpenChange(open: boolean): void; children: ReactNode }> & { Content?: ComponentType<{ children: ReactNode }> };
const host = HostRN as unknown as { useToast?: () => ToastApi; copyText?: (text: string) => Promise<void>; Modal?: ModalComponent };

const isComponent = (value: unknown) => typeof value === "function" || (typeof value === "object" && value !== null);
const hostModal = (): ModalComponent | null => (isComponent(host.Modal) ? (host.Modal as ModalComponent) : null);

/**
 * The app's toast, or null. Not a conditional hook in practice: the app's
 * exports are fixed for the life of the page, so every render takes the same
 * branch (read per call only so tests can stand in for each kind of app).
 */
export function useHostToast(): ToastApi | null {
  const use = host.useToast;
  return typeof use === "function" ? use() : null;
}

/** Longer and failing messages stay up longer: 4 to 10 seconds. */
export const toastDuration = (text: string) => Math.min(10_000, Math.max(4_000, Math.round(text.length * 60)));

/** A toast in the message's tone, redacted first. */
export function showToast(toast: ToastApi, message: NonNullable<Message>): void {
  const text = redactSecrets(message.text);
  const variant: ToastVariant = message.tone === "danger" ? "error" : message.tone === "success" ? "success" : message.tone === "warning" ? "warning" : "default";
  toast.show(text, { variant, durationMs: toastDuration(text) });
}

/** The page's "say": a toast where the app has them, else the message bar (`message`, shown by the caller). Never both. */
export function useSay(): [Message, (message: Message) => void] {
  const toast = useHostToast();
  const [message, setMessage] = useState<Message>(null);
  const say = useCallback((next: Message) => {
    if (next && toast) { showToast(toast, next); setMessage(null); }
    else setMessage(next ? { ...next, text: redactSecrets(next.text) } : null);
  }, [toast]);
  return [message, say];
}

/** Where an older app's replies go when it has no toast: the page's message bar. Screens provide it. */
const SayContext = createContext<((message: Message) => void) | null>(null);
const MessageContext = createContext<Message>(null);
export function SayProvider({ say, children }: { say: (message: Message) => void; children: ReactNode }) {
  return <SayContext.Provider value={say}>{children}</SayContext.Provider>;
}

/**
 * The page's say, held ABOVE everything on the page (0.15.0 review fix), so
 * hooks called by the page body itself (stop, open, copy) reach the message
 * bar on an app without toasts. The body reads it with `usePageSay`.
 */
export function SayRoot({ children }: { children: ReactNode }) {
  const [message, say] = useSay();
  return <SayContext.Provider value={say}><MessageContext.Provider value={message}>{children}</MessageContext.Provider></SayContext.Provider>;
}

const ignore = () => undefined;
/** The message bar's current message and the page's say (from SayRoot). */
export function usePageSay(): [Message, (message: Message) => void] {
  return [useContext(MessageContext), useContext(SayContext) ?? ignore];
}

/**
 * A toast API for components: the app's toast, redacted, where it has one;
 * otherwise the page's message bar (SayProvider), or nothing outside a page.
 */
export function useSafeToast(): ToastApi {
  const toast = useHostToast();
  const say = useContext(SayContext);
  return useMemo<ToastApi>(() => {
    const post = (text: string, tone: Tone) => {
      if (toast) showToast(toast, { text, tone });
      else say?.({ text: redactSecrets(text), tone });
    };
    return {
      show: (text, options) => post(text, options?.variant === "error" ? "danger" : options?.variant === "warning" ? "warning" : options?.variant === "success" ? "success" : "neutral"),
      error: (text) => post(text, "danger"),
    };
  }, [toast, say]);
}

/** An error for people: its message redacted and bounded, or a fixed safe sentence. Never raw output past 300 characters. */
export function errorText(error: unknown, fallback = "Something went wrong. Try again."): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = redactSecrets(raw.trim());
  if (!text) return fallback;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/**
 * Copies with the app's clipboard where it has one, else react-native's.
 * False when it couldn't: the app's copy rejected, or React Native Web's
 * setString answered false (the browser refused). Redacted first.
 */
export async function copyToClipboard(text: string, options: { verbatim?: boolean } = {}): Promise<boolean> {
  // `verbatim` is for one thing only: a pairing code the person just created and pressed "Copy code" for.
  // Carrying it to the other computer is the point, and it's on screen beside the button anyway.
  const safe = options.verbatim ? text : redactSecrets(text);
  try {
    if (typeof host.copyText === "function") { await host.copyText(safe); return true; }
    return (Clipboard.setString(safe) as unknown) !== false;
  } catch {
    return false;
  }
}

/** Copy and say so: "Copied", or "Couldn't copy" when the clipboard refused. */
export function useCopy(): (text: string, what?: string, options?: { verbatim?: boolean }) => Promise<boolean> {
  const toast = useSafeToast();
  return useCallback(async (text: string, what = "Copied", options?: { verbatim?: boolean }) => {
    const ok = await copyToClipboard(text, options);
    if (ok) toast.show(what, { variant: "success" }); else toast.show("Couldn't copy. Select the text and copy it instead.", { variant: "warning" });
    return ok;
  }, [toast]);
}

/**
 * A confirm action that runs once per opening (a ref, not state, so two
 * presses before React re-renders still act once). Re-armed when `open`
 * becomes true again.
 */
export function useOnce(open: boolean, action: () => void): () => void {
  const used = useRef(false);
  useEffect(() => { if (open) used.current = false; }, [open]);
  return () => {
    if (used.current) return;
    used.current = true;
    action();
  };
}

/**
 * A sheet (0.15.0 review fix): Paseo's dialog where the app has one; on an
 * app without it, the same content in place, framed like a card, so Stop,
 * Force stop and Ask an agent never crash for want of a Modal. `busy` keeps
 * it from being dismissed mid-action.
 */
export function Sheet({ title, icon, open, busy, onClose, colors, children }: {
  title: string;
  icon?: ReactNode;
  open: boolean;
  busy?: boolean;
  onClose(): void;
  colors: { surface: string; border: string; foreground: string };
  children: ReactNode;
}) {
  const HostModal = hostModal();
  if (HostModal) {
    const Content = HostModal.Content;
    return (
      <HostModal title={redactSecrets(title)} icon={icon} open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
        {Content ? <Content>{children}</Content> : children}
      </HostModal>
    );
  }
  if (!open) return null;
  return (
    <View accessibilityLabel={redactSecrets(title)} style={{ borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 16, marginVertical: SPACE.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingHorizontal: SPACE.card, paddingTop: SPACE.card }}>
        {icon ?? null}
        <Text style={{ ...TYPE.item, color: colors.foreground, flexShrink: 1 }}>{redactSecrets(title)}</Text>
      </View>
      {children}
    </View>
  );
}

/** Paseo's dialog, or null on an app without one. */
export const appModal = hostModal;

/** True on apps with Paseo's dialog. */
export const hasDialog = () => hostModal() !== null;

/**
 * Ask first. In Paseo's dialog where the app has one; in place (`inPlace`,
 * for the sidebar popover) or on an older app, as a warning and two buttons
 * right where the question came from. Single use: a second press before
 * React re-renders never runs the action twice; it re-arms only when the
 * question opens again. The caller resets its own state in `onCancel`.
 */
export function Confirm({ theme, open, title, text, confirmLabel, danger, busy, inPlace, onConfirm, onCancel }: {
  theme: PluginTheme;
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  inPlace?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const confirmOnce = useOnce(open, onConfirm);
  const words = redactSecrets(text);
  const buttons = (
    <Row>
      <Button theme={theme} label="Cancel" onPress={onCancel} disabled={busy} accessibilityLabel={`Cancel: ${title}`} />
      <Button theme={theme} label={confirmLabel} primary={!danger} danger={danger} busy={busy} onPress={confirmOnce} />
    </Row>
  );
  const HostModal = hostModal();
  if (!HostModal || inPlace) {
    if (!open) return null;
    return (
      <View style={{ gap: SPACE.sm }}>
        <Note theme={theme} tone="warning">{words}</Note>
        {buttons}
      </View>
    );
  }
  const Content = HostModal.Content;
  const body = (
    <View style={{ gap: SPACE.md }}>
      <Text style={{ ...TYPE.body, color: theme.colors.foreground }}>{words}</Text>
      {buttons}
    </View>
  );
  return (
    <HostModal title={redactSecrets(title)} open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      {Content ? <Content>{body}</Content> : body}
    </HostModal>
  );
}
