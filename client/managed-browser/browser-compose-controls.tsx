/** Explicit Compose draft UI, with original control/document ownership pinned until Done. */
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { ControlButton } from "./browser-chrome";
import type { createStyles } from "./browser-panel-styles";

type Theme = PluginWorkspacePanelProps["theme"];

/** Visible draft sheet; text reaches the focused page field only by an explicit Done. */
export function ComposeTextControls({
  styles,
  theme,
  composeText,
  cancelInput,
  enabled,
  ownershipKey,
  documentKey,
  request,
  onRequestHandled,
  onRequestControlForCompose,
  canRequestControl,
}: {
  styles: ReturnType<typeof createStyles>;
  theme: Theme;
  composeText(text: string): boolean;
  cancelInput(): void;
  enabled: boolean;
  ownershipKey: string;
  documentKey: string;
  request: { id: number; kind: "compose" | "commit"; ownershipKey: string } | null;
  onRequestHandled(id: number): void;
  onRequestControlForCompose(): void;
  canRequestControl: boolean;
}) {
  const handledRequest = useRef<number | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  // The input is host-owned (uncontrolled): echoing every character back through
  // React state let a fast second keystroke be overwritten by a stale value.
  // Latest text lives here; state changes only when emptiness flips or the draft resets.
  const text = useRef("");
  const generation = useRef(0);
  const [hasText, setHasText] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const draftGeneration = generation.current;
  const resetDraft = () => {
    generation.current += 1;
    text.current = "";
    setHasText(false);
    setInputKey(generation.current);
  };
  const composeOwner = useRef<string | null>(null);
  const composeDocument = useRef<string | null>(null);
  const liveAuthority = useRef({ enabled, ownershipKey });
  liveAuthority.current = { enabled, ownershipKey };
  const canCommit = enabled && composeOwner.current === ownershipKey;
  const canRebindCommit = enabled && composeDocument.current === documentKey;
  const canRequestCommit = canRequestControl && composeDocument.current === documentKey;
  const closeCompose = () => {
    setComposeOpen(false);
    resetDraft();
    composeOwner.current = null;
    composeDocument.current = null;
  };
  const openCompose = () => {
    cancelInput();
    resetDraft();
    composeOwner.current = ownershipKey;
    composeDocument.current = documentKey;
    setComposeOpen(true);
  };
  // Callbacks are fenced to the draft that rendered them: a retained Done/Cancel
  // from a closed draft must not publish, or close, a same-owner replacement.
  const commit = () => {
    if (generation.current !== draftGeneration) return;
    // Consume before publication: a rapid second Done or retained old handler
    // must not repeat insertion or borrow a replacement page's control.
    if (
      !liveAuthority.current.enabled ||
      liveAuthority.current.ownershipKey !== ownershipKey ||
      composeOwner.current !== ownershipKey ||
      !text.current
    )
      return;
    composeOwner.current = null;
    const accepted = composeText(text.current);
    // Publication may synchronously open a new draft; it owns the refs now.
    if (generation.current !== draftGeneration) return;
    if (accepted) {
      closeCompose();
    } else {
      // false means nothing was admitted, so the same draft remains reviewable.
      composeOwner.current = ownershipKey;
    }
  };
  const dismiss = () => {
    if (generation.current === draftGeneration) closeCompose();
  };
  // Menu dismissal commits before this effect; the sheet is mounted outside the menu.
  useEffect(() => {
    if (!request || handledRequest.current === request.id) return;
    handledRequest.current = request.id;
    if (enabled && request.ownershipKey === ownershipKey) {
      if (request.kind === "compose") openCompose();
      else if (composeOpen && composeDocument.current === documentKey && text.current) {
        composeOwner.current = ownershipKey;
        commit();
      }
    }
    onRequestHandled(request.id);
  }, [request, enabled, ownershipKey, documentKey, onRequestHandled]);
  return (
    <>
      <Modal
        title="Compose text"
        open={composeOpen}
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
      >
        <Modal.Content>
          <View style={styles.sheetContent}>
            <Text style={styles.devicePresetDetail}>
              Compose with your keyboard, then choose Done to insert the text into the focused page
              field.
            </Text>
            <TextInput
              autoFocus
              multiline
              key={inputKey}
              defaultValue=""
              maxLength={16_000}
              accessibilityLabel="Text to compose"
              onChangeText={(next) => {
                // A callback retained from a closed or replaced draft must not write into the new one.
                if (generation.current !== draftGeneration) return;
                text.current = next;
                setHasText(next.length > 0);
              }}
              style={[styles.field, { minHeight: 100 }]}
            />
            {!canCommit ? (
              <Text style={styles.devicePresetDetail}>
                Browser control or page changed. Close this draft and focus the field again.
              </Text>
            ) : null}
            <View style={styles.mobileRow}>
              <ControlButton styles={styles} theme={theme} label="Cancel" onPress={dismiss} />
              <ControlButton
                styles={styles}
                theme={theme}
                label="Done"
                primary
                disabled={(!canCommit && !canRebindCommit && !canRequestCommit) || !hasText}
                onPress={() => {
                  if (generation.current !== draftGeneration) return;
                  if (canCommit) {
                    commit();
                  } else if (canRebindCommit) {
                    composeOwner.current = ownershipKey;
                    commit();
                  } else {
                    onRequestControlForCompose();
                  }
                }}
              />
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
