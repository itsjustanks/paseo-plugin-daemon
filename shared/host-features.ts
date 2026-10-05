/**
 * Newer Paseo features Daemon Link uses only where the app has them. The
 * plugin builds against the 0.8 SDK and still loads on older apps, so each
 * feature is detected at runtime, here, purely, and the caller falls back to
 * what it did before. (The same tests as paseo-mcp 0.18.1.)
 */

type Fn = (...args: never[]) => unknown;
const isFn = (value: unknown): value is Fn => typeof value === "function";

/**
 * Paseo 0.11: a full screen plus a native sidebar row. All four parts must be
 * there (adding a screen, adding a sidebar row, opening a screen, and the
 * app's SidebarRow to draw it); otherwise the old surface and sidebar item.
 */
export function supportsNativeScreens(client: unknown, sidebarRow: unknown): boolean {
  const candidate = (client ?? {}) as Record<string, unknown>;
  return isFn(candidate.addScreen) && isFn(candidate.addSidebarHeaderItem) && isFn(candidate.openScreen) && Boolean(sidebarRow);
}

/** Paseo 0.10: `openExternalUrl` on the plugin client module, which opens the system browser. Null on older apps. */
export function externalUrlOpener(clientModule: unknown): ((url: string) => Promise<void>) | null {
  const candidate = (clientModule ?? {}) as { openExternalUrl?: unknown };
  return isFn(candidate.openExternalUrl) ? (candidate.openExternalUrl as (url: string) => Promise<void>) : null;
}

/**
 * Paseo 0.8.0 stable: composer chips are buttons ({ title, icon, label,
 * behavior }, returning { update, remove }). `addHeaderButton` shipped with
 * them; the 0.8.0-beta.1 SDK this plugin builds against has neither, and its
 * chip is a React component. True means use the button shape.
 */
export function supportsButtonPills(client: unknown): boolean {
  return isFn(((client ?? {}) as Record<string, unknown>).addHeaderButton);
}

/**
 * Paseo 0.9: `agents.subscribe()` only hears an observation the plugin opened
 * itself with `agents.list({ subscribe: {} })`; `observeEvents` shipped with
 * those observations. On a 0.8 app the plugin must not send `subscribe`: it
 * would replace the app's own agent subscription.
 */
export function canObserveAgents(paseo: unknown): boolean {
  return isFn(((paseo ?? {}) as Record<string, unknown>).observeEvents);
}
