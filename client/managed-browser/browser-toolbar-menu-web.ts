/** Web focus and dismissal for local menus; never forwards menu keys to Chromium. */
import { Platform } from "react-native";

interface FocusNode {
  focus(): void;
  contains(node: unknown): boolean;
  getAttribute(name: string): string | null;
  getClientRects?(): ArrayLike<unknown>;
  closest?(selector: string): unknown;
}
interface MenuNode extends FocusNode {
  querySelectorAll(selector: string): ArrayLike<FocusNode>;
  ownerDocument: {
    activeElement: unknown;
    querySelectorAll?(selector: string): ArrayLike<FocusNode>;
    addEventListener(type: string, listener: (event: MenuEvent) => void, capture: boolean): void;
    removeEventListener(type: string, listener: (event: MenuEvent) => void, capture: boolean): void;
  };
}
interface MenuEvent {
  key?: string;
  shiftKey?: boolean;
  target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

/** Restore trigger focus only if the menu still owns it and the action did not hand it away. */
export function bindBrowserToolbarMenuWeb(
  node: unknown,
  trigger: unknown,
  close: () => void,
  restoreFocus: () => boolean,
  overlay?: unknown,
  hierarchy?: { openSubmenu?(): void; back?(): void; closeRoot?(): void; nested?: boolean },
): () => void {
  if (Platform.OS !== "web" || !node || typeof node !== "object" || !("ownerDocument" in node)) {
    return () => {};
  }
  const menu = node as MenuNode;
  const anchor = trigger as MenuNode | null;
  const enabledItems = () =>
    Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(
      (item) =>
        item.getAttribute("aria-disabled") !== "true" &&
        item.getAttribute("disabled") === null &&
        (!item.closest || item.closest('[role="menu"]') === menu),
    );
  enabledItems()[0]?.focus();
  let focusOwned = menu.contains(menu.ownerDocument.activeElement);
  let returnTarget: FocusNode | null = null;
  const focusin = (event: MenuEvent) => {
    focusOwned = menu.contains(event.target);
  };

  const keydown = (event: MenuEvent) => {
    if (!menu.contains(event.target)) return;
    const target = event.target as FocusNode;
    // Only the root owns Tab exit. Its host-order calculation excludes the
    // entire popup, and its cleanup performs the one final focus restoration.
    if (event.key === "Tab" && hierarchy?.nested) return;
    if (event.key !== "Tab" && target.closest && target.closest('[role="menu"]') !== menu) return;
    if (
      event.key === "ArrowRight" &&
      target.getAttribute("aria-expanded") !== null &&
      hierarchy?.openSubmenu
    ) {
      event.preventDefault();
      event.stopPropagation();
      hierarchy.openSubmenu();
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "Escape") && hierarchy?.back) {
      event.preventDefault();
      event.stopPropagation();
      hierarchy.back();
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Tab") {
        // Menu Tab leaves the popup rather than walking its command rows or
        // trapping focus. Follow the trigger's surrounding host tab order.
        const triggerButton = Array.from(
          anchor?.querySelectorAll('[role="button"], [role="menuitem"]') ?? [],
        )[0];
        const focusable = Array.from(
          menu.ownerDocument.querySelectorAll?.(
            'button, [role="button"], input:not([type="hidden"]), select, textarea, a[href], [tabindex]',
          ) ?? [],
        ).filter(
          (item) =>
            !menu.contains(item) &&
            item.getAttribute("disabled") === null &&
            item.getAttribute("aria-disabled") !== "true" &&
            Number(item.getAttribute("tabindex") ?? 0) >= 0 &&
            !item.closest?.('[aria-hidden="true"], [inert]') &&
            (!item.getClientRects || item.getClientRects().length > 0),
        );
        const index = triggerButton ? focusable.indexOf(triggerButton) : -1;
        if (index >= 0)
          returnTarget = focusable[index + (event.shiftKey ? -1 : 1)] ?? triggerButton ?? null;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Tab" && hierarchy?.closeRoot) hierarchy.closeRoot();
      else close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key ?? "")) return;
    event.preventDefault();
    event.stopPropagation();
    const items = enabledItems();
    if (!items.length) return;
    const index = items.indexOf(menu.ownerDocument.activeElement as FocusNode);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else next = index <= 0 ? items.length - 1 : index - 1;
    items[next]?.focus();
  };
  const outside = (event: MenuEvent) => {
    if (hierarchy?.nested || menu.contains(event.target) || anchor?.contains(event.target)) return;
    // Consume backdrop presses before re-enabling the image below it. A local
    // dismiss must never become a newly controlled remote mouse-down.
    if (overlay && (overlay as FocusNode).contains(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    } else {
      // The user deliberately focused another host surface; leave it alone.
      focusOwned = false;
    }
    close();
  };
  menu.ownerDocument.addEventListener("keydown", keydown, true);
  menu.ownerDocument.addEventListener("pointerdown", outside, true);
  menu.ownerDocument.addEventListener("focusin", focusin, true);
  return () => {
    menu.ownerDocument.removeEventListener("keydown", keydown, true);
    menu.ownerDocument.removeEventListener("pointerdown", outside, true);
    menu.ownerDocument.removeEventListener("focusin", focusin, true);
    // Native React unmount can remove the focused row before passive cleanup.
    // Remember ownership rather than consulting only the now-detached node.
    if (restoreFocus() && focusOwned) {
      (
        returnTarget ??
        Array.from(anchor?.querySelectorAll('[role="button"], [role="menuitem"]') ?? [])[0]
      )?.focus();
    }
  };
}

/** Restore an in-menu trigger after compact Back, without touching native hosts. */
export function focusBrowserMenuTrigger(node: unknown): void {
  if (Platform.OS !== "web" || !node || typeof node !== "object" || !("querySelectorAll" in node))
    return;
  const trigger = node as MenuNode;
  Array.from(trigger.querySelectorAll('[role="menuitem"], [role="button"]'))[0]?.focus();
}
