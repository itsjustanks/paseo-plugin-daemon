import { setTimeout, clearTimeout } from "./node-timers";
/** Observes one native navigation's main-frame commit, never DOM readiness.
 * Events can precede the command ACK, so bounded receipts are buffered before
 * dispatch. A missing or detached post-ACK commit is uncertain, never replayed.
 */
import { type CdpSession, CdpUnknownOutcomeError } from "./cdp";

export interface NavigationCommitReceipt {
  frameId: string;
  loaderId?: string;
  previousLoaderId?: string;
  /** Required for same-document commits and history entry selection. */
  url?: string;
  download?: boolean;
}

type Commit = { frameId: string; loaderId?: string; url: string; sameDocument: boolean };

function normalizedUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** Dispatch once, then await the matching root commit within timeoutMs.
 * assertCurrent binds the original native attachment before and after waiting.
 * Download ACKs intentionally leave the current document unchanged.
 */
export async function waitForNavigationCommit(
  page: CdpSession,
  dispatch: () => Promise<NavigationCommitReceipt>,
  assertCurrent: () => void,
  timeoutMs: number,
): Promise<void> {
  const commits: Commit[] = [];
  let attachmentLost = false;
  let notify: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const append = (commit: Commit): void => {
    if (commits.length === 64) commits.shift();
    commits.push(commit);
    notify?.();
  };
  const frameNavigated = (event: {
    frame: { id: string; parentId?: string; loaderId?: string; url: string; urlFragment?: string };
  }): void => {
    if (event.frame.parentId) return;
    append({
      frameId: event.frame.id,
      ...(event.frame.loaderId ? { loaderId: event.frame.loaderId } : {}),
      // CDP Frame.url omits the fragment; history entries keep the full URL.
      url: event.frame.url + (event.frame.urlFragment ?? ""),
      sameDocument: false,
    });
  };
  const withinDocument = (event: { frameId: string; url: string }): void => {
    append({ frameId: event.frameId, url: event.url, sameDocument: true });
  };
  const detached = (): void => {
    attachmentLost = true;
    notify?.();
  };
  page.on("Page.frameNavigated", frameNavigated);
  page.on("Page.navigatedWithinDocument", withinDocument);
  page.on("Inspector.detached", detached);
  page.connection.on("disconnect", detached);

  try {
    assertCurrent();
    const receipt = await dispatch();
    const unknown = (): CdpUnknownOutcomeError =>
      new CdpUnknownOutcomeError(
        "Navigation was acknowledged but its matching document commit was not observed; outcome is unknown",
      );
    const checkCurrent = (): void => {
      if (attachmentLost) throw unknown();
      try {
        assertCurrent();
      } catch {
        throw unknown();
      }
    };
    checkCurrent();
    if (receipt.download) return;
    if (!receipt.frameId) throw unknown();
    const matches = (commit: Commit): boolean => {
      if (commit.frameId !== receipt.frameId) return false;
      if (receipt.loaderId) return !commit.sameDocument && commit.loaderId === receipt.loaderId;
      if (commit.sameDocument) {
        return (
          receipt.url !== undefined && normalizedUrl(commit.url) === normalizedUrl(receipt.url)
        );
      }
      // History/reload ACK has no loader. Require a fresh main loader, and the
      // selected history URL when known, rather than accepting an old event.
      return (
        receipt.previousLoaderId !== undefined &&
        commit.loaderId !== undefined &&
        commit.loaderId !== receipt.previousLoaderId &&
        (receipt.url === undefined || normalizedUrl(commit.url) === normalizedUrl(receipt.url))
      );
    };
    let expired = false;
    timer = setTimeout(() => {
      expired = true;
      notify?.();
    }, timeoutMs);
    for (;;) {
      checkCurrent();
      if (commits.some(matches)) return;
      if (expired) throw unknown();
      const waiter = Promise.withResolvers<void>();
      notify = waiter.resolve;
      await waiter.promise;
      notify = undefined;
    }
  } finally {
    if (timer) clearTimeout(timer);
    page.off("Page.frameNavigated", frameNavigated);
    page.off("Page.navigatedWithinDocument", withinDocument);
    page.off("Inspector.detached", detached);
    page.connection.off("disconnect", detached);
  }
}
