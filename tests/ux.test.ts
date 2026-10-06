import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { helperRole, paseoRole } from "../server/jobs";

const root = join(__dirname, "..");
const APP = "/Applications/Paseo.app/Contents";
const HELPER = `${APP}/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper`;

describe("0.12.1 real-app fixes", () => {
  it("the manifest has a plain description and asks for the Paseo that accepts one (0.9+; 0.8's schema is strict without it)", () => {
    const manifest = JSON.parse(readFileSync(join(root, "paseo-plugin.json"), "utf8"));
    expect(manifest.id).toBe("daemon-link");
    expect(manifest.description).toMatch(/^Hosts: /);
    expect(manifest.description.length).toBeLessThan(200);
    expect(manifest.requirements.paseo).toBe(">=0.9.0");
  });

  it("names each part of Paseo, so a dozen \"Paseo\" rows can be told apart", () => {
    expect(paseoRole({ argv: ["Paseo Daemon"], comm: "Paseo Daemon" }, true)).toBe("daemon");
    expect(paseoRole({ argv: ["Paseo Supervisor"], comm: "Paseo Supervisor" }, false)).toBe("supervisor");
    expect(paseoRole({ argv: [HELPER, `${APP}/Resources/app.asar/node_modules/@getpaseo/server/dist/server/server/plugins/plugin-process.js`], comm: "Paseo Helper" }, false)).toBe("plugin host");
    expect(paseoRole({ argv: [HELPER, `${APP}/Resources/app.asar/node_modules/@getpaseo/server/dist/server/terminal/terminal-worker-process.js`], comm: "Paseo Helper" }, false)).toBe("terminals");
    expect(paseoRole({ argv: [`${APP}/Frameworks/Paseo Helper (Renderer).app/Contents/MacOS/Paseo Helper (Renderer)`, "--type=renderer"], comm: "Paseo Helper (Renderer)" }, false)).toBe("window");
    expect(paseoRole({ argv: [HELPER, "--type=gpu-process"], comm: "Paseo Helper" }, false)).toBe("graphics");
    expect(paseoRole({ argv: [HELPER, "--type=utility", "--utility-sub-type=network.mojom.NetworkService"], comm: "Paseo Helper" }, false)).toBe("network");
    expect(paseoRole({ argv: [`${APP}/MacOS/Paseo`], comm: "Paseo" }, false)).toBe("app");
  });

  it("names a browser's or desktop app's helpers by role, and leaves anything else alone", () => {
    expect(helperRole(["Google Chrome Helper (Renderer)", "--type=renderer"])).toBe("window or tab");
    expect(helperRole(["Google Chrome Helper (Renderer)", "--type=renderer", "--extension-process"])).toBe("extension");
    expect(helperRole(["Slack Helper", "--type=utility", "--utility-sub-type=audio.mojom.AudioService"])).toBe("audio");
    expect(helperRole(["chrome_crashpad_handler", "--type=crashpad-handler"])).toBe("crash reporter");
    expect(helperRole(["node", "server.js", "--port=3000"])).toBeNull();
  });

  it("rows that still look the same show their PID", async () => {
    const { twinKeys } = await import("../shared/processes");
    const rows = [
      { name: "Paseo", owner: { label: "Paseo · window" }, ports: [] },
      { name: "Paseo", owner: { label: "Paseo · window" }, ports: [] },
      { name: "Paseo", owner: { label: "Paseo · graphics" }, ports: [] },
    ];
    expect(twinKeys(rows as never).size).toBe(1);
  });

  it("uses one name: no \"Daemon Link\" in anything a person reads, and the command is /hosts", () => {
    const visible = ["client/peers.tsx", "client/guide.tsx", "client/daemon.tsx", "client/home.tsx", "client/processes.tsx", "client/workspace-panel.tsx", "client/settings.tsx", "index.client.tsx", "server/processes.ts", "server/scope.ts", "server/peers.ts", "server/links.ts", "server/gate.ts", "server/relay.ts", "server/tunnels.ts"];
    for (const file of visible) {
      const text = readFileSync(join(root, file), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
      expect(text, file).not.toMatch(/["'`>][^"'`<]*Daemon Link[^"'`<]*["'`<]/);
    }
    const client = readFileSync(join(root, "index.client.tsx"), "utf8");
    expect(client).toMatch(/name: "hosts"/);
    expect(client).not.toMatch(/name: "daemon-link"/);
  });
});
