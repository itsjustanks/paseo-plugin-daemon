// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { createConnection } from "node:net";

import { lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "./temp-dir.test-support";
import { serveTools } from "../../server/cross-daemon/tool-socket.server";

describe("serveTools", () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => { await Promise.all(stops.splice(0).map((stop) => stop())); });

  it("starts on a fresh install, when the plugin's state folder does not exist yet", async () => {
    const socketPath = join(makeTempDir("cd-"), "not-yet", "tools.sock");
    stops.push(
      serveTools(socketPath, {
        definitions: [],
        call: async () => ({ text: "pong" }),
      }),
    );
    const reply = await new Promise<string>((resolve, reject) => {
      let body = "";
      const connect = () => {
        const socket = createConnection(socketPath);
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => (body += chunk));
        socket.on("end", () => resolve(body));
        socket.on("error", reject);
        socket.end(JSON.stringify({ type: "call", name: "ping", arguments: {}, callerAgentId: null }));
      };
      setTimeout(connect, 50);
    });
    expect(JSON.parse(reply)).toEqual({ text: "pong" });
  });
});

it("refuses an occupied endpoint and never unlinks a replacement during cleanup", async () => {
  const socketPath = join(makeTempDir("hcd-socket-owner-"), "tools.sock");
  const tools = { definitions: [], call: async () => ({ text: "owner" }) };
  writeFileSync(socketPath, "foreign");
  expect(() => serveTools(socketPath, tools)).toThrow("unavailable");
  expect(readFileSync(socketPath, "utf8")).toBe("foreign"); unlinkSync(socketPath);
  const stop = serveTools(socketPath, tools); await stop.ready;
  unlinkSync(socketPath); writeFileSync(socketPath, "replacement");
  const replacement = lstatSync(socketPath);
  await stop(); await stop();
  expect(lstatSync(socketPath).ino).toBe(replacement.ino);
  expect(readFileSync(socketPath, "utf8")).toBe("replacement");
});
it("can stop before publication without leaving an endpoint", async () => {
  const socketPath = join(makeTempDir("hcd-socket-stop-"), "tools.sock");
  const stop = serveTools(socketPath, { definitions: [], call: async () => ({ text: "unused" }) });
  await stop(); await expect(stop.ready).rejects.toThrow("stopped");
  expect(() => lstatSync(socketPath)).toThrow();
});
it("contains malformed requests and tool failures", async () => {
  const socketPath = join(makeTempDir("hcd-socket-failure-"), "tools.sock");
  const stop = serveTools(socketPath, { definitions: [], call: async () => { throw new Error("private details"); } });
  await stop.ready;
  const request = (body: string) => new Promise<string>((resolve, reject) => {
    let reply = ""; const socket = createConnection(socketPath);
    socket.setEncoding("utf8"); socket.on("data", (chunk) => reply += chunk);
    socket.on("end", () => resolve(reply)); socket.on("error", reject); socket.end(body);
  });
  try {
    expect(await request("{} ")).toContain("Malformed");
    expect(await request("not-json")).toContain("details withheld");
    const reply = await request(JSON.stringify({ type: "call", name: "fake", arguments: {}, callerAgentId: null }));
    expect(reply).toContain("details withheld"); expect(reply).not.toContain("private details");
  } finally { await stop(); }
});
