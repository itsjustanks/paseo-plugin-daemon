import { errorText, useSafeToast, Sheet } from "./feedback";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { askContext, terminalOpen, type AskSubject } from "../shared/ask";
import { Button, HostIcon, ItemTitle, Meta, Note, RADIUS, Row, SPACE, TYPE, tint } from "./kit";

type Theme = PluginTheme;
type Navigation = { openAgent?: (input: { agentId: string }) => void; openWorkspace?: (input: { workspaceId: string }) => void } | undefined;

/**
 * "Ask an agent" and "Open a terminal here" (0.12.0). Both need the app's
 * Paseo session (`usePaseo`), so each is feature-detected and simply absent
 * where the app can't do it. The daemon writes the message (`askContext`,
 * redacted there); this sheet shows it word for word, lets the person pick a
 * chat in that workspace or start one, and sends only on Send. A busy agent
 * is steered (`activeTurnBehavior: "steer"`), never interrupted.
 */

/** Where the sheet can send people afterwards; screens set it once. */
const HostsNavigation = createContext<Navigation>(undefined);
export function HostsNavigationProvider({ navigation, children }: { navigation: Navigation; children: React.ReactNode }) {
  return <HostsNavigation.Provider value={navigation}>{children}</HostsNavigation.Provider>;
}

/** The app's Paseo session, or null on an app that doesn't provide one to plugins. */
export function useOptionalPaseo(): PaseoApi | null {
  try { return usePaseo() ?? null; } catch { return null; }
}
export const canAsk = (paseo: PaseoApi | null): paseo is PaseoApi => typeof paseo?.agents?.list === "function" && typeof paseo.agents.ref === "function";
export const canOpenTerminal = (paseo: PaseoApi | null): boolean => typeof paseo?.terminals?.create === "function";

type Agent = { id: string; title: string; status: string; provider: string; model: string | null; workspaceId: string | null; updatedAt: string };
const NEW = "__new__";
/** Other workspaces' chats offered after this workspace's own. */
const OTHERS_MAX = 5;

const STATUS_WORD: Record<string, string> = { running: "Working now", idle: "Idle", error: "Stopped with an error", initializing: "Starting" };

async function recentAgents(paseo: PaseoApi): Promise<Agent[]> {
  const result = await paseo.agents.list({ scope: "active", sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 60 } } as never);
  return (result.entries ?? [])
    .map((entry) => entry.agent)
    .filter((agent) => agent && !agent.archivedAt && agent.status !== "closed")
    .map((agent) => ({ id: agent.id, title: agent.title || `${agent.provider} chat`, status: agent.status, provider: agent.provider, model: agent.model ?? null, workspaceId: agent.workspaceId ?? null, updatedAt: agent.updatedAt }));
}

/** The chats to offer, this workspace's first; and the model a new chat would use (the most recent chat's). */
export function agentChoices(agents: readonly Agent[], workspaceId: string | null): { here: Agent[]; others: Agent[]; template: Agent | null } {
  const here = workspaceId ? agents.filter((agent) => agent.workspaceId === workspaceId) : [];
  const others = agents.filter((agent) => !here.includes(agent)).slice(0, here.length ? OTHERS_MAX : OTHERS_MAX * 2);
  const template = [...here, ...agents].find((agent) => agent.model) ?? null;
  return { here, others, template };
}

function Choice({ theme, selected, title, detail, onPress }: { theme: Theme; selected: boolean; title: string; detail: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityLabel={title} accessibilityState={{ selected }} onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: SPACE.row, padding: SPACE.row, borderRadius: RADIUS.control, borderWidth: 1, borderColor: selected ? theme.colors.accent : theme.colors.border, backgroundColor: selected ? tint(theme.colors.accent, 0.08) ?? theme.colors.surface2 : "transparent" }}>
      <View style={{ width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: selected ? theme.colors.accent : theme.colors.border, alignItems: "center", justifyContent: "center" }}>
        {selected ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accent }} /> : null}
      </View>
      <View style={{ flex: 1, gap: SPACE.hair }}>
        <Text numberOfLines={1} style={{ ...TYPE.item, color: theme.colors.foreground }}>{title}</Text>
        <Meta theme={theme}>{detail}</Meta>
      </View>
    </Pressable>
  );
}

function AskSheet({ theme, paseo, subject, open, onClose }: { theme: Theme; paseo: PaseoApi; subject: AskSubject; open: boolean; onClose(): void }) {
  const navigation = useContext(HostsNavigation);
  const readContext = useRpc(askContext);
  const context = useQuery({ queryKey: ["daemon-link", "ask", subject], queryFn: () => readContext({ subject }), enabled: open, staleTime: 0, gcTime: 0, retry: 0 });
  const agents = useQuery({ queryKey: ["daemon-link", "ask-agents"], queryFn: () => recentAgents(paseo), enabled: open, staleTime: 0, retry: 0 });
  const choices = useMemo(() => agentChoices(agents.data ?? [], context.data?.workspaceId ?? null), [agents.data, context.data]);
  const canStart = !!context.data?.workspaceId && !!choices.template && typeof paseo.workspaces?.ref === "function";
  const [picked, setPicked] = useState<string | null>(null);
  const choice = picked ?? choices.here[0]?.id ?? (canStart ? NEW : choices.others[0]?.id ?? null);
  const chosen = [...choices.here, ...choices.others].find((agent) => agent.id === choice) ?? null;
  const send = useMutation({
    mutationFn: async (): Promise<{ id: string; title: string }> => {
      const text = context.data!.text;
      if (choice === NEW) {
        const template = choices.template!;
        const handle = await paseo.workspaces.ref(context.data!.workspaceId!).agents.create({ config: { provider: `${template.provider}/${template.model}` }, prompt: text, title: context.data!.title });
        return { id: handle.id, title: context.data!.title };
      }
      // `activeTurnBehavior` reaches the daemon from every client since 0.8; only the handle's type gained it in 0.11.0-beta.1.
      const handle = paseo.agents.ref(chosen!.id);
      await (handle.send as (text: string, options: { activeTurnBehavior: "steer" }) => Promise<void>).call(handle, text, { activeTurnBehavior: "steer" });
      return { id: chosen!.id, title: chosen!.title };
    },
  });
  const close = () => { if (!send.isPending) { send.reset(); setPicked(null); onClose(); } };
  const sent = send.data;
  const body = { ...TYPE.body, color: theme.colors.foreground };
  return (
    <Sheet title={sent ? "Sent" : "Ask an agent"} icon={HostIcon ? <HostIcon name="Bot" size={18} color={theme.colors.accent} /> : undefined} open={open} onClose={close} colors={{ surface: theme.colors.surface1, border: theme.colors.border, foreground: theme.colors.foreground }}>
        <View style={{ gap: SPACE.row, padding: SPACE.card, maxWidth: 640 }}>
          {sent ? (
            <>
              <Note theme={theme}>{`Sent to ${sent.title}. ${choice === NEW ? "The new chat starts on it now." : chosen?.status === "running" ? "It was working, so this was added to what it's doing rather than stopping it." : "It will reply in its chat."}`}</Note>
              <Row>
                {navigation?.openAgent ? <Button theme={theme} label="Open the chat" icon="MessageSquare" primary onPress={() => { navigation.openAgent!({ agentId: sent.id }); close(); }} /> : null}
                <Button theme={theme} label="Close" onPress={close} />
              </Row>
            </>
          ) : context.isPending || agents.isPending ? (
            <View style={{ padding: SPACE.section, alignItems: "center" }}><ActivityIndicator color={theme.colors.accent} /></View>
          ) : context.error || !context.data ? (
            <>
              <Note theme={theme} tone="danger">{context.error instanceof Error ? context.error.message : "Hosts couldn't describe this problem."}</Note>
              <Row><Button theme={theme} label="Close" onPress={close} /></Row>
            </>
          ) : (
            <>
              <ItemTitle theme={theme}>{context.data.title}</ItemTitle>
              <Text style={body}>Choose who should look at it. You'll see exactly what is sent; nothing goes until you press Send.</Text>
              <View accessibilityRole="radiogroup" style={{ gap: SPACE.sm }}>
                {choices.here.length ? <Meta theme={theme}>{`Chats in ${context.data.workspaceName ?? "this workspace"}`}</Meta> : null}
                {choices.here.map((agent) => <Choice key={agent.id} theme={theme} selected={choice === agent.id} title={agent.title} detail={`${STATUS_WORD[agent.status] ?? agent.status} · ${agent.provider}`} onPress={() => setPicked(agent.id)} />)}
                {canStart ? <Choice theme={theme} selected={choice === NEW} title={`Start a new chat in ${context.data.workspaceName ?? "this workspace"}`} detail={`${choices.template!.provider} · ${choices.template!.model}, like your latest chat`} onPress={() => setPicked(NEW)} /> : null}
                {choices.others.length ? <Meta theme={theme}>{choices.here.length || canStart ? "Other chats" : "Recent chats"}</Meta> : null}
                {choices.others.map((agent) => <Choice key={agent.id} theme={theme} selected={choice === agent.id} title={agent.title} detail={`${STATUS_WORD[agent.status] ?? agent.status} · ${agent.provider}`} onPress={() => setPicked(agent.id)} />)}
                {agents.error ? <Note theme={theme} tone="danger">{`Your chats couldn't be listed: ${agents.error instanceof Error ? agents.error.message : String(agents.error)}`}</Note>
                  : !choices.here.length && !choices.others.length && !canStart ? <Note theme={theme}>No chats are open on this host. Start one in the workspace, then try again.</Note> : null}
              </View>
              <Meta theme={theme}>{`What will be sent${context.data.outputFrom ? `, with the last lines of ${context.data.outputFrom}` : ""}. Secrets in commands and output are removed first.`}</Meta>
              <ScrollView style={{ maxHeight: 280, borderWidth: 1, borderColor: theme.colors.border, borderRadius: RADIUS.control, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: SPACE.row }}>
                <Text selectable accessibilityLabel="Message preview" style={{ ...TYPE.mono, color: theme.colors.foreground }}>{context.data.text}</Text>
              </ScrollView>
              {chosen?.status === "running" ? <Meta theme={theme}>It's working right now: this is added to what it's doing, without stopping it.</Meta> : null}
              {send.error ? <Note theme={theme} tone="danger">{send.error instanceof Error ? send.error.message : String(send.error)}</Note> : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: SPACE.sm }}>
                <Button theme={theme} label="Cancel" onPress={close} disabled={send.isPending} />
                <Button theme={theme} label={choice === NEW ? "Start the chat" : chosen ? `Send to ${chosen.title.length > 28 ? `${chosen.title.slice(0, 27)}…` : chosen.title}` : "Send"} icon="Send" primary busy={send.isPending} disabled={!choice} onPress={() => send.mutate()} />
              </View>
            </>
          )}
        </View>
    </Sheet>
  );
}

/** "Ask an agent", where something has gone wrong. Nothing at all on an app that can't reach agents. */
export function AskAgentButton({ theme, subject, label = "Ask an agent", primary, openNow, onOpened }: { theme: Theme; subject: AskSubject; label?: string; primary?: boolean; openNow?: boolean; onOpened?(): void }) {
  const paseo = useOptionalPaseo();
  const [open, setOpen] = useState(false);
  // A link asked for the sheet ("Clean up disk space"): open it once, and say so, so it doesn't open again.
  useEffect(() => { if (openNow && canAsk(paseo)) { setOpen(true); onOpened?.(); } }, [openNow]);
  if (!canAsk(paseo)) return null;
  return (
    <>
      <Button theme={theme} label={label} icon="Bot" primary={primary} accessibilityLabel={`${label} about this`} onPress={() => setOpen(true)} />
      {open ? <AskSheet theme={theme} paseo={paseo} subject={subject} open={open} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** "Open a terminal here": a Paseo terminal in a dev server's folder, inside its workspace. */
export function OpenTerminalButton({ theme, pid }: { theme: Theme; pid: number }) {
  const paseo = useOptionalPaseo();
  const navigation = useContext(HostsNavigation);
  const toast = useSafeToast();
  const openRpc = useRpc(terminalOpen);
  const opening = useMutation({
    mutationFn: () => openRpc({ pid }),
    onSuccess: (result) => {
      if (!result.ok) { toast.error(result.message); return; }
      toast.show(result.message, { variant: "success" });
      if (result.workspaceId && navigation?.openWorkspace) navigation.openWorkspace({ workspaceId: result.workspaceId });
    },
    onError: (error) => toast.error(errorText(error)),
  });
  if (!canOpenTerminal(paseo)) return null;
  return <Row><Button theme={theme} label="Open a terminal here" icon="SquareTerminal" busy={opening.isPending} onPress={() => opening.mutate()} /></Row>;
}
