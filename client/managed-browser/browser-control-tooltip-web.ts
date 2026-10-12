/** Native browser hover titles for public RN web control refs; native clients keep accessibility labels. */
import { Platform } from "react-native";

/** Attach the control's current accessible name without creating overlays or remote input handlers. */
export function setBrowserControlTooltip(node: unknown, label: string): void {
  if (Platform.OS !== "web" || !node || typeof node !== "object") return;
  if ("setAttribute" in node && typeof node.setAttribute === "function") {
    node.setAttribute("title", label);
  }
}
