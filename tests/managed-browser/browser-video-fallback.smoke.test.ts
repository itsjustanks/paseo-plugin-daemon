import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { BrowserFrame, BrowserState } from "../../shared/managed-browser/browser";
import { FRAME_MAX_BYTES } from "../../shared/managed-browser/capture-settings";
import type { BrowserVideoReadReply } from "../../shared/managed-browser/browser-video";
import { SessionManager } from "../../server/managed-browser/browser-policy";
import { createRuntimeOwner } from "../../server/managed-browser/runtime-owner";
import { SupervisorClient } from "../../server/managed-browser/supervisor-client";
import { resolveSupervisorPaths, startSupervisorServer } from "../../server/managed-browser/supervisor";

const expected = (state: BrowserState) => ({ sessionId: state.sessionId, navigationGeneration: state.navigationGeneration, viewportGeneration: state.viewportGeneration });
const target = (frame: Pick<BrowserFrame, "frameId" | "navigationGeneration" | "viewportGeneration">) => ({ frameId: frame.frameId, navigationGeneration: frame.navigationGeneration, viewportGeneration: frame.viewportGeneration });

it("falls back from complex 4K native video and recovers live video-authorized input at ordinary size", async () => {
  if (!process.env.HOSTS_BROWSER_AGENT_BROWSER_BINARY || !process.env.HOSTS_BROWSER_CHROMIUM_EXECUTABLE)
    throw new Error("Native fallback smoke requires explicit owned private browser binaries");
  const home = await mkdtemp(join(tmpdir(), "hosts-video-fallback-"));
  await writeFile(join(home, "OWNED"), home, { mode: 0o600 });
  vi.stubEnv("PASEO_HOME", home);
  const typed: string[] = [];
  const http = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/typed") { typed.push(url.searchParams.get("value") ?? ""); response.writeHead(204).end(); return; }
    const noise = url.pathname === "/noise";
    response.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><title>Loading owned fixture</title>
      <style>html,body{margin:0;overflow:hidden;background:#f4f6f8}canvas{position:absolute;inset:0}input{position:absolute;left:40px;top:120px;width:220px;height:36px;font:18px system-ui}</style>
      ${noise ? '<canvas width="3840" height="3840"></canvas>' : '<h1>Owned video recovery</h1><input><div id="counter"></div>'}
      <script>${noise ? `const c=document.querySelector('canvas').getContext('2d'),image=c.createImageData(3840,3840),pixels=new Uint32Array(image.data.buffer);let seed=123456789;for(let i=0;i<pixels.length;i++){seed=(Math.imul(seed,1664525)+1013904223)|0;pixels[i]=0xff000000|(seed&0xffffff)}c.putImageData(image,0,0);let n=0;setInterval(()=>{c.fillStyle=n++%2?'#fff':'#000';c.fillRect(300,20,100,100)},100);` : `let n=0;setInterval(()=>counter.textContent=String(++n),100);document.querySelector('input').addEventListener('input',e=>fetch('/typed?value='+encodeURIComponent(e.target.value)));`}
      document.title='Owned fixture ready';</script>`);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Owned fixture port unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  const paths = resolveSupervisorPaths(home);
  const running = await startSupervisorServer(await createRuntimeOwner({ nativeVideo: true }), paths);
  const manager = new SessionManager({ client: new SupervisorClient({ bridgeId: "owned-video-fallback", paths }), validateWorkspace: async (id) => id === "owned-video-fallback" });
  try {
    await manager.connect();
    const viewer = await manager.attach("owned-video-fallback", "Owned fallback smoke");
    const control = await manager.acquireControl(viewer.viewerToken, false);
    let state = (await manager.resize({ viewerToken: viewer.viewerToken, controlToken: control.controlToken, expected: expected(control.state), viewport: { width: 3840, height: 3840 } })).state;
    state = (await manager.navigate({ viewerToken: viewer.viewerToken, controlToken: control.controlToken, expected: expected(state), action: { kind: "goto", url: `${origin}/noise` } })).state;
    await vi.waitFor(async () => expect((await manager.status(viewer.viewerToken)).state.title).toBe("Owned fixture ready"), { timeout: 5_000 });
    for (const bitrate of [24_000_000, 12_000_000] as const) {
      let reply: BrowserVideoReadReply | undefined;
      for (let attempt = 0; attempt < 8; attempt++) {
        reply = await manager.readVideo({ viewerToken: viewer.viewerToken, quality: "high", bitrate, fps: 60, streamId: null, afterSequence: 0, waitMs: 500, requestKeyFrame: true });
        if (reply.status === "unsupported" || reply.packets.length) break;
      }
      expect(reply).toBeDefined();
      console.log("native-fallback-cohort", { bitrate, status: reply!.status, packets: reply!.packets.length });
      // Codec/keyframe output varies by platform. Every accepted packet must stay bounded;
      // oversized frames may refuse video, but must still leave JPEG capture usable.
      expect(reply!.packets.every((packet) => Buffer.byteLength(packet.dataBase64, "base64") <= 512 * 1024)).toBe(true);
    }
    const fallbackStarted = performance.now();
    const fallback = await manager.capture(viewer.viewerToken, "medium", null);
    console.log("native-fallback-jpeg", { ms: performance.now() - fallbackStarted, bytes: fallback.frame?.byteLength });
    expect(fallback.frame).toMatchObject({ width: 3840, height: 3840, transport: "screenshot" });
    expect(fallback.frame!.byteLength).toBeLessThanOrEqual(FRAME_MAX_BYTES);
    state = (await manager.resize({ viewerToken: viewer.viewerToken, controlToken: control.controlToken, expected: expected(fallback.state), viewport: { width: 1280, height: 800 } })).state;
    state = (await manager.navigate({ viewerToken: viewer.viewerToken, controlToken: control.controlToken, expected: expected(state), action: { kind: "goto", url: `${origin}/plain` } })).state;
    let streamId: string | null = null;
    let afterSequence = 0;
    async function freshVideo(): Promise<BrowserVideoReadReply> {
      for (let attempt = 0; attempt < 12; attempt++) {
        const reply = await manager.readVideo({ viewerToken: viewer.viewerToken, quality: "high", bitrate: 12_000_000, fps: 30, streamId, afterSequence, waitMs: 500, requestKeyFrame: streamId === null });
        if (reply.status === "reset") { streamId = null; afterSequence = 0; }
        for (const packet of reply.packets) { streamId = packet.streamId; afterSequence = packet.sequence; }
        if (reply.packets.some((packet) => packet.actionable)) return reply;
      }
      throw new Error("Ordinary viewport did not recover actionable native video");
    }
    const recoveryStarted = performance.now();
    let video = await freshVideo();
    console.log("native-fallback-video-recovered", { ms: performance.now() - recoveryStarted, packets: video.packets.length });
    let packet = video.packets.find((value) => value.actionable)!;
    expect(packet).toMatchObject({ width: 1280, height: 800 });
    await manager.sendInput({ viewerToken: viewer.viewerToken, controlToken: control.controlToken, expected: expected(video.state), target: target(packet.frame), event: { kind: "click", point: { x: 100, y: 138, width: 1280, height: 800 }, button: "left", clickCount: 1 } });
    video = await freshVideo(); packet = video.packets.find((value) => value.actionable)!;
    await manager.sendInput({ viewerToken: viewer.viewerToken, controlToken: control.controlToken, expected: expected(video.state), target: target(packet.frame), event: { kind: "type", text: "VideoBack" } });
    await vi.waitFor(() => expect(typed).toEqual(["VideoBack"]), { timeout: 3_000 });
    await manager.releaseControl(viewer.viewerToken, control.controlToken);
    await manager.detach(viewer.viewerToken);
    await manager.archiveWorkspace("owned-video-fallback");
  } finally {
    manager.disconnect(); await running.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);
