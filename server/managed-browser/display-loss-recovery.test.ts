import { describe, expect, it } from "vitest";
import { browserStateSchema } from "../../shared/managed-browser/browser";
import { type JsonValue, RuntimeLostError } from "./runtime-protocol";
import { RuntimeSupervisor } from "./supervisor";

/** Only an explicit human attach replaces a runtime whose private display died, behind a new fence. */
function harness() {
  const events: string[] = [];
  const control = {
    created: 0,
    lostRuntime: 0,
    genericFailure: false,
    stopFails: false,
    clock: 1_000,
  };
  const supervisor = new RuntimeSupervisor({
    now: () => control.clock,
    owner: {
      create: async () => {
        control.created += 1;
        events.push(`create:${control.created}`);
        return {
          runtimeId: `${"r".repeat(30)}${String(control.created).padStart(2, "0")}`,
          id: control.created,
        };
      },
      request: async (runtime, operation) => {
        events.push(`${operation}:${runtime.id}`);
        if (control.genericFailure) throw new Error("fixture generic failure");
        if (runtime.id === control.lostRuntime)
          throw new RuntimeLostError("Private browser display ended");
        if (operation === "identity") return { userAgent: "Fixture Chromium" };
        if (operation === "state")
          return {
            url: "https://fixture.invalid",
            title: "Fixture",
            canGoBack: false,
            canGoForward: false,
            inputGeneration: "0:0",
          };
        if (operation === "frame")
          return {
            dataBase64: "eA==",
            byteLength: 1,
            width: 1280,
            height: 800,
            capturedAt: new Date(control.clock).toISOString(),
          };
        return null;
      },
      stop: async (runtime) => {
        events.push(`stop:${runtime.id}`);
        if (control.stopFails) throw new Error("fixture stop unconfirmed");
      },
    },
  });
  const lease = supervisor.claimBridge("bridge");
  const request = (operation: string, input: unknown) =>
    supervisor.dispatch({
      version: 3,
      id: "request",
      token: "unused-by-direct-fixture",
      bridgeId: "bridge",
      epoch: lease.epoch,
      method: "browser.request",
      operation,
      input: input as JsonValue,
    });
  const attach = async () =>
    (await request("attach", { create: true, workspaceId: "workspace", viewerLabel: "Viewer" })) as {
      viewerToken: string;
      state: unknown;
    };
  const count = (prefix: string) => events.filter((event) => event.startsWith(prefix)).length;
  return { supervisor, lease, events, control, request, attach, count };
}

describe("display loss recovery", () => {
  it("recreates a lost runtime on the next attach and rejects every old attachment", async () => {
    const h = harness();
    try {
      const first = await h.attach();
      const control = (await h.request("acquire-control", { viewerToken: first.viewerToken })) as {
        controlToken: string;
      };
      const before = browserStateSchema.parse(first.state);

      h.control.lostRuntime = 1;
      const failed = (await h.request("status", { viewerToken: first.viewerToken })) as {
        state: { status: string };
      };
      expect(failed.state.status).toBe("error");
      // Plain polling never restarts the browser.
      expect(h.control.created).toBe(1);
      expect(h.count("stop")).toBe(0);

      const second = await h.attach();
      const after = browserStateSchema.parse(second.state);
      expect(after.status).toBe("ready");
      expect(after.sessionId).not.toBe(before.sessionId);
      expect(after.runtimeId).not.toBe(before.runtimeId);
      expect(h.events.indexOf("stop:1")).toBeGreaterThan(-1);
      expect(h.events.indexOf("stop:1")).toBeLessThan(h.events.indexOf("create:2"));
      expect(h.events.some((event) => event.startsWith("mouse") || event === "navigate:1")).toBe(
        false,
      );

      await expect(h.request("status", { viewerToken: first.viewerToken })).rejects.toThrow();
      await expect(
        h.request("input", {
          viewerToken: first.viewerToken,
          controlToken: control.controlToken,
          expected: {
            sessionId: before.sessionId,
            runtimeId: before.runtimeId,
            navigationGeneration: before.navigationGeneration,
            viewportGeneration: before.viewportGeneration,
          },
          event: { kind: "move", point: { x: 1, y: 1 } },
        }),
      ).rejects.toThrow();
      await expect(h.request("status", { viewerToken: second.viewerToken })).resolves.toBeTruthy();
    } finally {
      await h.supervisor.stopAll();
    }
  });

  it("replaces once within the first attach after loss no earlier request observed", async () => {
    const h = harness();
    try {
      const first = await h.attach();
      const before = browserStateSchema.parse(first.state);
      h.control.lostRuntime = 1; // nothing polled since the display died

      const second = await h.attach();
      const after = browserStateSchema.parse(second.state);
      expect(after.status).toBe("ready");
      expect(after.runtimeId).not.toBe(before.runtimeId);
      expect(after.sessionId).not.toBe(before.sessionId);
      expect(h.control.created).toBe(2);
      expect(h.events.filter((event) => event.startsWith("stop"))).toEqual(["stop:1"]);
      await expect(h.request("status", { viewerToken: first.viewerToken })).rejects.toThrow();
    } finally {
      await h.supervisor.stopAll();
    }
  });

  it("does not retry or replace on a generic error and never replays input", async () => {
    const h = harness();
    try {
      await h.attach();
      h.control.genericFailure = true;
      const again = browserStateSchema.parse((await h.attach()).state);
      expect(again.status).toBe("error");
      expect(h.control.created).toBe(1);
      expect(h.count("stop")).toBe(0);
    } finally {
      await h.supervisor.stopAll();
    }
  });

  it("keeps implicit agent observation from replacing an existing lost runtime", async () => {
    const h = harness();
    const ticket = `agent_${"x".repeat(40)}`;
    const agentRequest = (operation: "status" | "capture") =>
      h.supervisor.dispatch({
        id: "agent",
        version: 3,
        method: "agent.request",
        ticket,
        operation,
        input: {},
      }) as Promise<{ state: { status: string } }>;
    try {
      const human = await h.attach();
      const base = {
        version: 3 as const,
        token: "unused",
        bridgeId: "bridge",
        epoch: h.lease.epoch,
      };
      await h.supervisor.dispatch({ ...base, id: "t1", method: "ticket.issue", ticket });
      await h.supervisor.dispatch({
        ...base,
        id: "t2",
        method: "ticket.bind",
        ticket,
        agentId: "agent-one",
        workspaceId: "workspace",
      });
      expect((await agentRequest("status")).state.status).toBe("ready");

      // Initial binding path: another agent binds only after the runtime was lost.
      h.control.lostRuntime = 1;
      const lateTicket = `late_${"y".repeat(40)}`;
      await h.supervisor.dispatch({
        ...base,
        id: "t3",
        method: "ticket.issue",
        ticket: lateTicket,
      });
      await h.supervisor.dispatch({
        ...base,
        id: "t4",
        method: "ticket.bind",
        ticket: lateTicket,
        agentId: "agent-two",
        workspaceId: "workspace",
      });
      const late = (await h.supervisor.dispatch({
        id: "agent-late",
        version: 3,
        method: "agent.request",
        ticket: lateTicket,
        operation: "status",
        input: {},
      })) as unknown as { state: { status: string } };
      expect(late.state.status).toBe("error");

      // Expired-viewer path: the first agent's viewer lapses, then it observes again.
      for (let step = 0; step < 3; step += 1) {
        h.control.clock += 20_000; // beyond the 45 s viewer TTL, within each bridge lease
        h.supervisor.heartbeat("bridge", h.lease.epoch);
      }
      expect((await agentRequest("status")).state.status).toBe("error");
      await expect(agentRequest("capture")).rejects.toMatchObject({ code: "RUNTIME_LOST" });
      expect(h.control.created).toBe(1);
      expect(h.count("stop")).toBe(0);

      // Only the explicit human reconnect recovers.
      const recovered = browserStateSchema.parse((await h.attach()).state);
      expect(recovered.status).toBe("ready");
      expect(h.control.created).toBe(2);
      expect(h.events.filter((event) => event.startsWith("stop"))).toEqual(["stop:1"]);
      expect(human.viewerToken).toBeTruthy();
    } finally {
      await h.supervisor.stopAll();
    }
  });

  it("keeps a lost runtime whose stop failed away from implicit agent paths until explicit recovery", async () => {
    const h = harness();
    const ticket = `agent_${"x".repeat(40)}`;
    const base = { version: 3 as const, token: "unused", bridgeId: "bridge", epoch: h.lease.epoch };
    const agentRequest = (operation: "status" | "capture") =>
      h.supervisor.dispatch({
        id: "agent",
        version: 3,
        method: "agent.request",
        ticket,
        operation,
        input: {},
      });
    try {
      await h.attach();
      h.control.lostRuntime = 1;
      h.control.stopFails = true;
      // The explicit reconnect discards its session, then cannot confirm the old runtime stopped.
      await expect(h.attach()).rejects.toThrow("stop unconfirmed");
      const stopsAfterFailure = h.count("stop");
      expect(h.control.created).toBe(1);

      await h.supervisor.dispatch({ ...base, id: "t1", method: "ticket.issue", ticket });
      await h.supervisor.dispatch({
        ...base,
        id: "t2",
        method: "ticket.bind",
        ticket,
        agentId: "agent-one",
        workspaceId: "workspace",
      });
      await expect(agentRequest("status")).rejects.toMatchObject({ code: "RUNTIME_LOST" });
      await expect(agentRequest("capture")).rejects.toMatchObject({ code: "RUNTIME_LOST" });
      // Protocol-level ensure carries no replacement authority either.
      await expect(
        h.supervisor.dispatch({
          ...base,
          id: "ensure",
          method: "workspace.ensure",
          workspaceId: "workspace",
        }),
      ).rejects.toMatchObject({ code: "RUNTIME_LOST" });
      expect(h.count("stop")).toBe(stopsAfterFailure);
      expect(h.control.created).toBe(1);

      h.control.stopFails = false;
      const recovered = browserStateSchema.parse((await h.attach()).state);
      expect(recovered.status).toBe("ready");
      expect(h.control.created).toBe(2);
    } finally {
      await h.supervisor.stopAll();
    }
  });
});
