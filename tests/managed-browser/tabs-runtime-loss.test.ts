import { afterEach, expect, it } from "vitest";
import { type BrowserRuntimeClient, SessionManager } from "../../server/managed-browser/browser-policy";
import { type JsonValue, RuntimeProtocolError } from "../../server/managed-browser/runtime-protocol";

/** One lost workspace runtime serves every tab session; replacement is explicit and fenced. */
class LossClient implements BrowserRuntimeClient {
  runtime = 1;
  lost = false;
  readonly ensures: boolean[] = [];
  private pages = new Set<string>();

  async connect() {
    return { epoch: 1 };
  }

  async ensureWorkspace(workspaceId: string, options?: { replaceLost?: boolean }) {
    this.ensures.push(options?.replaceLost === true);
    if (this.lost) {
      if (!options?.replaceLost) throw new RuntimeProtocolError("RUNTIME_LOST", "runtime lost");
      this.lost = false;
      this.runtime += 1;
      this.pages.clear();
    }
    if (this.pages.size === 0) this.pages.add(`r${this.runtime}-page-one`);
    return { workspaceId, runtimeId: `runtime-${this.runtime}`, createdAt: this.runtime };
  }

  async requestWorkspace(_w: string, operation: string, input: JsonValue): Promise<JsonValue> {
    if (this.lost) throw new RuntimeProtocolError("RUNTIME_LOST", "Private display ended");
    const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    if (operation === "tabs.list")
      return [...this.pages].map((targetId) => ({ targetId, title: targetId, url: "https://x/" }));
    if (operation === "tabs.create") {
      const id = `r${this.runtime}-page-${this.pages.size + 1}`;
      this.pages.add(id);
      return { targetId: id };
    }
    const first = [...this.pages][0] ?? "";
    const targetId = typeof data.targetId === "string" ? data.targetId : first;
    if (!this.pages.has(targetId)) throw new Error("Browser tab is no longer available");
    if (operation === "identity") return { targetId, userAgent: "Fake" };
    if (operation === "state")
      return {
        url: "https://x/",
        title: targetId,
        canGoBack: false,
        canGoForward: false,
        inputGeneration: "0:0",
      };
    return null;
  }

  async archiveWorkspace() {}
  async closeWorkspace() {}
  disconnect() {}
}

const managers: SessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.disconnect();
});

function setup() {
  let counter = 0;
  const client = new LossClient();
  const manager = new SessionManager({
    client,
    validateWorkspace: async () => true,
    issueToken: () => `token_${String(++counter).padStart(40, "0")}`,
  });
  managers.push(manager);
  return { client, manager };
}

it("replaces every tab session of a lost runtime only on explicit attach, behind new ids", async () => {
  const { client, manager } = setup();
  const first = await manager.attach("ws", "First");
  const created = await manager.createTab(first.viewerToken);
  const second = await manager.attach("ws", "Second", created.tabId);

  client.lost = true;
  // Implicit observation notices the loss but never replaces anything.
  await manager.status(first.viewerToken).catch(() => undefined);
  await manager.listTabs("ws").catch(() => undefined);
  const observer = await manager.attach("ws", "Observer");
  expect(observer.state.status).toBe("error");
  expect(client.runtime).toBe(1);

  // An explicit human attach, even naming a tab of the dead browser, replaces once.
  const replaced = await manager.attach("ws", "Human", created.tabId, { replaceLost: true });
  expect(client.runtime).toBe(2);
  expect(replaced.state.runtimeId).toBe("runtime-2");
  expect(replaced.state.tabId).toBe("r2-page-one");
  expect(replaced.state.sessionId).not.toBe(first.state.sessionId);
  // Old viewer tokens of both tab sessions are fenced; nothing was replayed to them.
  await expect(manager.status(first.viewerToken)).rejects.toThrow();
  await expect(manager.status(second.viewerToken)).rejects.toThrow();
  expect((await manager.status(replaced.viewerToken)).state.runtimeId).toBe("runtime-2");
});
