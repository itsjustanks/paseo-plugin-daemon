// Fictional local-only RPC data. This module never imports daemon code or contacts a host.
import { registerDaemon } from "../../client/cross-daemon/sync-scheduler.client";
const params = new URLSearchParams(location.search);
const browser = params.get("browser") ?? "follow";
const tabs = [{ id: "tab-board", title: "Atlas · launch board", url: "https://atlas.example.test/board" }, { id: "tab-docs", title: "Atlas documentation", url: "https://docs.example.test/" }];
let image: Promise<string> | null = null;
let viewers = 0;
let profiles = params.get("recovery") === "empty" ? [] : [{ id: "00000000-0000-4000-8000-000000000001", revision: 1, name: "Development host", hostname: "dev.example.test", user: "paseo", port: null, auth: { kind: "config" }, preset: "docker", container: "paseo-dev-stack-paseo", unit: "paseo.service", sudo: false }];
const offline = { code: "unreachable", message: "The target did not answer SSH. Check the host and network from this runner.", checkedAt: Date.now(), state: "unknown" };

export async function headlessFixture(name: string, input: any): Promise<any> {
  if (name === "daemon-link.browser.sessions") return { sessions: browser === "empty" ? [] : [{ id: "fictional-session", name: "design-review", pid: 5001, version: "0.27.0", workspaceId: "ws-fixture", workspace: "Atlas", chatId: "a1", chat: "Review launch board", attribution: "chat", viewable: browser !== "unavailable", limitation: browser === "unavailable" ? "No unambiguous local Chrome CDP listener could be verified. A pipe-only or external browser cannot be attached safely." : null }], warnings: [] };
  if (name === "daemon-link.browser.open") return { viewerId: `fictional-view-${++viewers}`, tabs, expiresInMs: 15000 };
  if (name === "daemon-link.browser.frame") {
    image ??= fetch("/browser-fixture.jpg").then(response => response.blob()).then(blob => new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(blob); }));
    return { frame: { tabId: input.tabId, data: await image, width: 1280, height: 720, capturedAt: Date.now() }, tabs, message: null };
  }
  if (name === "daemon-link.browser.close") return { ok: true };
  if (name === "hosts.recovery.list") return { profiles, checks: Object.fromEntries(profiles.map(profile => [profile.id, offline])) };
  if (name === "hosts.recovery.save") { const profile = { ...input.details, id: input.id ?? "00000000-0000-4000-8000-000000000001", revision: input.expectedRevision + 1 }; profiles = [...profiles.filter(old => old.id !== profile.id), profile]; return profile; }
  if (name === "hosts.recovery.test") return offline;
  if (name === "hosts.recovery.preview") return { token: "00000000-0000-4000-8000-000000000002", profile: profiles.find(profile => profile.id === input.id), action: input.action, expiresAt: Date.now() + 60000 };
  if (name === "hosts.recovery.confirm") return { code: "sent", message: "Fictional request complete. No host was contacted.", checkedAt: Date.now(), state: "unknown" };
  if (name === "hosts.recovery.cancel") return { ok: true };
  return undefined;
}
export const fixtureHosts = [{ serverId: "fixture-helper", label: "Always-on helper", status: "online" as const }, { serverId: "fixture-target", label: "Development host", status: "offline" as const }];
export function registerPreviewDaemons() {
  let enabled = false;
  return registerDaemon({
    status: async () => ({ serverId: "fixture-helper", switchedOn: enabled, available: true }),
    describe: async () => ({ serverId: "fixture-helper", switchedOn: enabled, member: null }),
    listPeers: async () => [], setPeers: async () => {},
    setSwitch: async (next, confirmed) => { if (next && !confirmed) throw new Error("Fictional confirmation required"); enabled = next; },
  });
}
