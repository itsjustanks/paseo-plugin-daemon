import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { BROWSER_RUNTIME_RESTART_IMPACT, browserRuntimeUpgradeRpc, type BrowserRuntimeUpgradeReply } from "../../shared/managed-browser/browser-runtime-upgrade";

/** Mount only in the legacy-runtime blocked state, including exact-tab attach failures.
 * Mounting does not inspect processes. Preview, confirm and recheck are explicit. */
export function BrowserRuntimeUpgradeAction({ theme, hostLabel, onVerified }: {
  theme: PluginWorkspacePanelProps["theme"]; hostLabel: string; onVerified?(): void;
}) {
  const rpc = useRpc(browserRuntimeUpgradeRpc);
  const [result, setResult] = useState<BrowserRuntimeUpgradeReply | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true), cancelButton = useRef<{ focus?(): void } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const confirming = result?.status === "confirmation-required";
  useEffect(() => { if (confirming) cancelButton.current?.focus?.(); }, [confirming]);
  const call = async (input: Parameters<typeof rpc>[0]) => {
    if (pending) return;
    setPending(true);
    try {
      const next = await rpc(input);
      if (mounted.current) { setResult(next); if (next.status === "complete") onVerified?.(); }
    } catch {
      if (mounted.current) setResult({ status: "unknown", message: "Restart result is unavailable. Recheck before taking another action. No automatic retry will run." });
    } finally { if (mounted.current) setPending(false); }
  };
  const cancel = () => { if (!pending) { setResult(null); void call({ action: "cancel" }); } };
  const colors = theme.colors;
  const button = (label: string, onPress: () => void, cancelRef = false) => <Pressable
    ref={cancelRef ? node => { cancelButton.current = node as unknown as { focus?(): void }; } : undefined}
    accessibilityRole="button" accessibilityLabel={label} disabled={pending}
    onPress={onPress} style={{ padding: 12, minHeight: 44, opacity: pending ? 0.5 : 1 }}>
    <Text style={{ color: colors.accent }}>{label}</Text>
  </Pressable>;
  return <View style={{ gap: 8 }}>
    {result && !confirming ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted }}>{result.message}</Text> : null}
    {result?.status === "unknown" ? button("Recheck browser runtime restart", () => { void call({ action: "recheck" }); })
      : result?.status !== "complete" ? button("Restart Hosts browser runtime", () => { void call({ action: "preview" }); }) : null}
    <Modal title="Restart Hosts browser runtime?" open={confirming} onOpenChange={open => { if (!open) cancel(); }}>
      <Modal.Content>
        <View style={{ padding: 20, gap: 12 }}>
          <Text style={{ color: colors.foreground }}>Selected host: {hostLabel}</Text>
          <Text style={{ color: colors.foreground }}>{BROWSER_RUNTIME_RESTART_IMPACT}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {button("Cancel", cancel, true)}
            {button("Close all managed sessions and restart", () => {
              // expiresAt belongs to the selected server's clock. The server
              // authoritatively rejects expired/consumed approval on confirm.
              if (!result?.approvalToken) {
                setResult({ status: "blocked", message: "Approval is unavailable. Inspect again before confirming." }); return;
              }
              void call({ action: "confirm", approvalToken: result.approvalToken, closeAllManagedSessions: true });
            })}
          </View>
        </View>
      </Modal.Content>
    </Modal>
  </View>;
}
