/** Confirm a one-time control request before the selected tab action continues. */
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import type { BrowserState } from "../../shared/managed-browser/browser";
import { ControlButton } from "./browser-chrome";
import type { ControlRequest } from "./browser-control-request";
import { BrowserDialogBody } from "./browser-dialog-body";
import type { createStyles } from "./browser-panel-styles";

/** Explicitly name a displaced controller while preserving the original action. */
export function BrowserControlDialog({
  styles,
  theme,
  state,
  request,
  pending,
  available,
  onCancel,
  onConfirm,
}: {
  styles: ReturnType<typeof createStyles>;
  theme: PluginWorkspacePanelProps["theme"];
  state: BrowserState | null;
  request: ControlRequest | null;
  pending: boolean;
  available: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const takeover = state?.controller === "other";
  return (
    <Modal
      title={takeover ? "Take over control?" : "Take control?"}
      icon={<Icon name="MousePointer2" size={18} color={theme.colors.foreground} />}
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <Modal.Content>
        <BrowserDialogBody
          styles={styles}
          actions={
            <>
              <ControlButton
                styles={styles}
                theme={theme}
                label="Cancel"
                disabled={pending}
                onPress={onCancel}
              />
              <ControlButton
                styles={styles}
                theme={theme}
                label={takeover ? "Take over" : "Take control"}
                primary
                disabled={pending || !request || !available}
                onPress={onConfirm}
              />
            </>
          }
        >
          {takeover
            ? `${state?.controllerLabel ?? "Another viewer"} controls this tab. Taking over will interrupt their input. `
            : "This tab is in observation mode. "}
          Take control to {request?.label}.
        </BrowserDialogBody>
      </Modal.Content>
    </Modal>
  );
}
