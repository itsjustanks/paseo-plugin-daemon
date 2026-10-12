/** Qualify native and web image-load events before the current decode-ticket handoff. */

/**
 * Native Image may report its loaded source URI; React Native Web instead wraps
 * a DOM load Event without that field. The unique decoder ticket remains the
 * authority when no URI is reported. A contradictory reported URI is rejected.
 * The settlement callback must still check current viewer, mutation and browser
 * generations before committing pixels or input authority.
 */
export function createBrowserImageLoadHandler(
  ticket: number,
  expectedUri: string,
  settle: (ticket: number, succeeded: boolean) => unknown,
): (event: unknown) => void {
  return (event) => {
    const nativeEvent =
      event && typeof event === "object" && "nativeEvent" in event ? event.nativeEvent : undefined;
    const source =
      nativeEvent && typeof nativeEvent === "object" && "source" in nativeEvent
        ? nativeEvent.source
        : undefined;
    const uri = source && typeof source === "object" && "uri" in source ? source.uri : undefined;
    if (uri && uri !== expectedUri) return;
    settle(ticket, true);
  };
}
