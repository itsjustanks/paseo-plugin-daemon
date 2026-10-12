import { randomUUID } from "node:crypto";
import { BROWSER_FRAME_INTERVAL_MS, BROWSER_LEASE_MS, BROWSER_MAX_BASE64, BROWSER_MAX_HEIGHT, BROWSER_MAX_WIDTH, type BrowserFrame, type BrowserTab } from "../shared/browser";
import { connectBrowserCdp, type BrowserCdp } from "./browser-cdp";
import { BrowserDiscovery, type DiscoveredBrowser } from "./browser-discovery";
import { redactSecrets } from "./redaction";
import { readJpegFrameDimensions } from "./browser-jpeg";

type Target = { targetId: string; type: string; title: string; url: string };
type Viewer = { id: string; session: DiscoveredBrowser; connection: BrowserCdp; expires: number; attached: { targetId: string; sessionId: string } | null; busy: boolean; frame: BrowserFrame | null; tabs: BrowserTab[]; lastAttempt: number };
export function browserDisplayUrl(raw: string): string {
  if (raw === "about:blank") return raw;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "Private or internal page";
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return redactSecrets(url.href).slice(0, 500);
  } catch { return "Page address unavailable"; }
}
export function browserDisplayTitle(raw: string): string {
  return redactSecrets(raw.replace(/https?:\/\/[^\s<>"']+/gi, (url) => browserDisplayUrl(url))).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240);
}
export class BrowserSessions {
  private readonly viewers = new Map<string, Viewer>();
  private pendingOpens = 0;
  private disposed = false;
  private listPending: ReturnType<BrowserDiscovery["list"]> | null = null;
  private inventory: Awaited<ReturnType<BrowserDiscovery["list"]>> | null = null;
  private listedAt = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly discovery: Pick<BrowserDiscovery, "list" | "verify" | "endpoint">, private readonly connect = connectBrowserCdp, private readonly now = Date.now) {
    this.timer = setInterval(() => {
      for (const viewer of this.viewers.values()) if (viewer.expires <= this.now()) this.release(viewer.id);
    }, 1_000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
  private async discover(force = false) {
    if (this.disposed) throw new Error("Browser viewer is closed.");
    if (!force && this.inventory && this.now() - this.listedAt < 5_000) return this.inventory;
    this.listPending ??= this.discovery.list().then((result) => { this.inventory = result; this.listedAt = this.now(); return result; }).finally(() => { this.listPending = null; });
    return this.listPending;
  }
  async list({ workspaceId }: { workspaceId?: string } = {}) {
    const inventory = await this.discover();
    return { sessions: inventory.sessions.map((session) => session.row).filter((row) => !workspaceId || row.workspaceId === workspaceId), warnings: inventory.warnings };
  }
  async open({ sessionId }: { sessionId: string }) {
    if (this.disposed || this.viewers.size + this.pendingOpens >= 4) throw new Error("Four browser views are already open. Close one and try again.");
    this.pendingOpens++;
    let connection: BrowserCdp | null = null;
    try {
      const session = (await this.discover(true)).sessions.find((session) => session.row.id === sessionId);
      if (this.disposed) throw new Error("Browser viewer is closed.");
      if (!session) throw new Error("This browser session ended or changed. Refresh the session list.");
      const endpoint = await this.discovery.endpoint(session);
      if (this.disposed) throw new Error("Browser viewer is closed.");
      connection = await this.connect(endpoint);
      if (this.disposed) throw new Error("Browser viewer is closed.");
      const tabs = await this.tabs(connection);
      await this.discovery.verify(session);
      if (this.disposed) throw new Error("Browser viewer is closed.");
      const viewer: Viewer = { id: randomUUID(), session, connection, expires: this.now() + BROWSER_LEASE_MS, attached: null, busy: false, frame: null, tabs, lastAttempt: -Infinity };
      this.viewers.set(viewer.id, viewer);
      return { viewerId: viewer.id, tabs, expiresInMs: BROWSER_LEASE_MS };
    } catch (error) { connection?.close(); throw error; }
    finally { this.pendingOpens--; }
  }
  private async tabs(connection: BrowserCdp): Promise<BrowserTab[]> {
    const { targetInfos } = await connection.send<{ targetInfos: Target[] }>("Target.getTargets");
    if (!Array.isArray(targetInfos)) throw new Error("Chrome did not provide a tab list.");
    return targetInfos.filter((target) => target.type === "page" && /^[a-zA-Z0-9_-]{1,128}$/.test(target.targetId)).slice(0, 100).map((target) => ({
      id: target.targetId, title: browserDisplayTitle(typeof target.title === "string" ? target.title : "Untitled tab"), url: browserDisplayUrl(target.url),
    }));
  }
  async frame({ viewerId, tabId }: { viewerId: string; tabId: string }) {
    const viewer = this.viewers.get(viewerId);
    if (!viewer || viewer.expires <= this.now()) { this.release(viewerId); throw new Error("This browser view expired. Open the session again."); }
    if (viewer.busy) throw new Error("A browser frame is already being captured.");
    // Rate-limit the OS rechecks and tab reads too, not just screenshot production.
    if (this.now() - viewer.lastAttempt < BROWSER_FRAME_INTERVAL_MS) return { frame: viewer.frame?.tabId === tabId ? viewer.frame : null, tabs: viewer.tabs, message: null };
    viewer.lastAttempt = this.now();
    viewer.busy = true;
    // Refresh the lease only for an admitted request. No timer captures anything.
    viewer.expires = this.now() + BROWSER_LEASE_MS;
    try {
      await this.discovery.verify(viewer.session);
      this.assertCurrent(viewer);
      const tabs = await this.tabs(viewer.connection);
      viewer.tabs = tabs;
      if (!tabs.some((tab) => tab.id === tabId)) {
        await this.detach(viewer); viewer.frame = null;
        return { frame: null, tabs, message: "The selected tab closed. Choose another tab to keep watching." };
      }
      if (viewer.attached?.targetId !== tabId) {
        await this.detach(viewer);
        const { sessionId } = await viewer.connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId: tabId, flatten: true });
        viewer.attached = { targetId: tabId, sessionId };
      }
      this.assertCurrent(viewer);
      const sessionId = viewer.attached!.sessionId;
      const { cssVisualViewport: viewport } = await viewer.connection.send<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics", {}, sessionId);
      if (!viewport || ![viewport.pageX, viewport.pageY, viewport.clientWidth, viewport.clientHeight].every(Number.isFinite) || viewport.clientWidth <= 0 || viewport.clientHeight <= 0 || viewport.clientWidth > 16_384 || viewport.clientHeight > 16_384) throw new Error("This tab's viewport cannot be captured safely.");
      const scale = Math.min(1, BROWSER_MAX_WIDTH / viewport.clientWidth, BROWSER_MAX_HEIGHT / viewport.clientHeight);
      const { data } = await viewer.connection.send<{ data: string }>("Page.captureScreenshot", {
        format: "jpeg", quality: 55, fromSurface: true, captureBeyondViewport: false,
        clip: { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale },
      }, sessionId);
      if (typeof data !== "string" || data.length > BROWSER_MAX_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("The browser frame exceeded the safe image limit.");
      const dimensions = readJpegFrameDimensions(data);
      if (!dimensions || dimensions.width > BROWSER_MAX_WIDTH || dimensions.height > BROWSER_MAX_HEIGHT) throw new Error("Chrome returned an invalid or oversized browser frame.");
      await this.discovery.verify(viewer.session);
      this.assertCurrent(viewer);
      viewer.frame = { tabId, data, ...dimensions, capturedAt: this.now() };
      return { frame: viewer.frame, tabs, message: null };
    } catch (error) { this.release(viewerId); throw error; }
    finally { viewer.busy = false; }
  }
  private assertCurrent(viewer: Viewer) {
    if (this.disposed || this.viewers.get(viewer.id) !== viewer || viewer.expires <= this.now()) throw new Error("This browser view closed or expired.");
  }
  private async detach(viewer: Viewer) {
    const attached = viewer.attached; viewer.attached = null;
    if (attached) await viewer.connection.send("Target.detachFromTarget", { sessionId: attached.sessionId });
  }
  private release(id: string) {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    this.viewers.delete(id); viewer.frame = null;
    // Closing our CDP socket detaches all its sessions, including a lost attach reply.
    // Never Browser.close, Target.closeTarget, stream_disable, or an Agent Browser lifecycle command.
    viewer.connection.close();
  }
  closeView({ viewerId }: { viewerId: string }) { this.release(viewerId); return { ok: true as const }; }
  close() { this.disposed = true; clearInterval(this.timer); for (const id of this.viewers.keys()) this.release(id); this.inventory = null; }
}
