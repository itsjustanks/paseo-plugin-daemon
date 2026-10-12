/** Apply the local device default only after this viewer first owns the shared browser. */
import { useEffect, useRef } from "react";
import type { BrowserState } from "../../shared/managed-browser/browser";
import {
  createEmulationChoices,
  type EmulationSelection,
  readLocalDevice,
  selectionMode,
} from "./browser-emulation-mode";

interface ModeOptions {
  identity: string;
  platform: "ios" | "android" | "web";
  state: BrowserState | null;
  canControl: boolean;
  pending: boolean;
  apply(selection: EmulationSelection): void;
}

/** Observers never mutate emulation; failed changes remain explicit errors and are not retried. */
export function useBrowserEmulationMode(options: ModeOptions) {
  const owned = useRef({
    identity: options.identity,
    choices: createEmulationChoices(readLocalDevice(options.platform)),
  });
  if (owned.current.identity !== options.identity) {
    owned.current = {
      identity: options.identity,
      choices: createEmulationChoices(readLocalDevice(options.platform)),
    };
  }
  const choices = owned.current.choices;
  const presetId = options.state?.devicePresetId ?? null;
  const mode = selectionMode(presetId);
  useEffect(() => {
    if (options.state) choices.remember(presetId);
  }, [choices, presetId, Boolean(options.state)]);
  useEffect(() => {
    if (!options.canControl || options.pending || options.state?.status !== "ready") return;
    const selection = choices.claimDefault(mode);
    if (selection) options.apply(selection);
  }, [choices, mode, options.canControl, options.pending, options.state?.status, options.apply]);
  return {
    mode,
    toggle: () => {
      if (
        owned.current.choices !== choices ||
        !options.canControl ||
        options.pending ||
        options.state?.status !== "ready"
      )
        return;
      options.apply(choices.toggle(mode));
    },
  };
}
