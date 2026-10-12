// Adapted from maxwell-01 cross-daemon, MIT, revision 975f8c4c062cb78ca82b203c8952e6c31621a9e6.
// See docs/cross-daemon-LICENSE.txt.
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPaseoCli } from "../../server/cross-daemon/paseo-cli.server";
import { makeTempDir } from "./temp-dir.test-support";

function fakePaseo(body: string, timeoutMs?: number) {
  const script = join(makeTempDir("cd-cli-"), "paseo.mjs");
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return createPaseoCli({ command: process.execPath, args: [script], home: "/tmp/paseo-home" }, timeoutMs);
}

describe("createPaseoCli", () => {
  it("keeps the peer link in child-only PASEO_HOST, never argv or PASEO_HOME", async () => {
    const link = "https://app.paseo.sh/#offer=" + "bWFj";
    const originalHome = process.env.PASEO_HOME; const originalHost = process.env.PASEO_HOST;
    process.env.PASEO_HOME = "/inherited/home"; process.env.PASEO_HOST = "inherited-target";
    const cli = fakePaseo("process.stdout.write(JSON.stringify({args: process.argv.slice(2), host: process.env.PASEO_HOST, home: process.env.PASEO_HOME}));");
    try {
      const output = JSON.parse(await cli.run(link, ["ls", "--json"]));
      expect(output).toEqual({ args: ["ls", "--json"], host: link });
      expect(output.args.join(" ")).not.toContain(link);
      expect(process.env.PASEO_HOME).toBe("/inherited/home"); expect(process.env.PASEO_HOST).toBe("inherited-target");
      const local = JSON.parse(await cli.runLocal(["inspect", "agent"]));
      expect(local.args).toEqual(["--home", "/tmp/paseo-home", "inspect", "agent"]);
      expect(local.host).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = originalHome;
      if (originalHost === undefined) delete process.env.PASEO_HOST; else process.env.PASEO_HOST = originalHost;
    }
  });

  it("does not hand this daemon's password to another daemon", async () => {
    const saved = process.env.PASEO_PASSWORD;
    process.env.PASEO_PASSWORD = "local-secret";
    const cli = fakePaseo("process.stdout.write(String(process.env.PASEO_PASSWORD));");
    try {
      await expect(cli.run("https://app.paseo.sh/#offer=bWFj", [])).resolves.toBe("undefined");
    } finally {
      if (saved === undefined) delete process.env.PASEO_PASSWORD;
      else process.env.PASEO_PASSWORD = saved;
    }
  });

  it("says a call timed out when it had to be stopped", async () => {
    const cli = fakePaseo("setTimeout(() => {}, 10_000);", 200);
    await expect(cli.run("https://app.paseo.sh/#offer=bWFj", [])).rejects.toThrow("timed out after 0.2 s");
  });

  it("fails with the message from the CLI's JSON error", async () => {
    const cli = fakePaseo(
      'process.stderr.write(JSON.stringify({ error: { code: "INSPECT_FAILED", message: "Agent not found: abc" } })); process.exit(1);',
    );
    await expect(cli.run("https://app.paseo.sh/#offer=bWFj", ["inspect", "abc", "--json"])).rejects.toThrow(/^Agent not found$/);
  });

  it("fails with the CLI's error output", async () => {
    const cli = fakePaseo('process.stderr.write("Agent not found: abc"); process.exit(1);');
    await expect(cli.run("https://app.paseo.sh/#offer=bWFj", ["logs", "abc"])).rejects.toThrow("Agent not found");
  });
});

describe("prompts passed through a file", () => {
  it("passes the prompt in a file, keeps it out of the arguments, and removes the file afterwards", async () => {
    const cli = fakePaseo(
      'import { readFileSync, existsSync } from "node:fs"; const args = process.argv.slice(2); const file = args[args.indexOf("--prompt-file") + 1]; process.stdout.write(JSON.stringify({ args, text: readFileSync(file, "utf8"), file }));',
    );
    const output = JSON.parse(await cli.run("https://app.paseo.sh/#offer=bWFj", ["send", "a1"], { promptText: "--home /etc secret plan" }));
    expect(output.text).toBe("--home /etc secret plan");
    expect(output.args.join(" ")).not.toContain("secret plan");
    expect(existsSync(output.file)).toBe(false);
  });

  it("removes the prompt file when the call fails", async () => {
    const cli = fakePaseo(
      'const args = process.argv.slice(2); process.stderr.write(args[args.indexOf("--prompt-file") + 1]); process.exit(1);',
    );
    const error = await cli.run("https://app.paseo.sh/#offer=bWFj", ["send", "a1"], { promptText: "hi" }).catch((failure: Error) => failure);
    expect(existsSync(String(error instanceof Error ? error.message : ""))).toBe(false);
  });
});
