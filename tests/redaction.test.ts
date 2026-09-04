import { describe, expect, it } from "vitest";
import { DISPLAY_COMMAND_MAX, displayCommand, displayName, hashArgv, homeRelative, redactArgv } from "../redaction.server";
import {
  SYNTHETIC_ANTHROPIC_KEY,
  SYNTHETIC_AWS_ACCESS_KEY,
  SYNTHETIC_BEARER_VALUE,
  SYNTHETIC_GITHUB_TOKEN,
  SYNTHETIC_JWT,
  SYNTHETIC_NPM_TOKEN,
  SYNTHETIC_PASSWORD,
  SYNTHETIC_SHAPES,
  SYNTHETIC_SLACK_TOKEN,
} from "./synthetic-secrets";

const HOME = "/home/alice";

const SECRETS = [
  SYNTHETIC_ANTHROPIC_KEY,
  SYNTHETIC_GITHUB_TOKEN,
  SYNTHETIC_AWS_ACCESS_KEY,
  SYNTHETIC_SLACK_TOKEN,
  SYNTHETIC_JWT,
  SYNTHETIC_PASSWORD,
  SYNTHETIC_NPM_TOKEN,
];

describe("redaction", () => {
  it("synthetic secrets are assembled into the shapes the redactor targets", () => {
    for (const { value, prefix, minLength } of SYNTHETIC_SHAPES) {
      expect(value.startsWith(prefix)).toBe(true);
      expect(value.length).toBeGreaterThanOrEqual(minLength);
    }
    expect(SYNTHETIC_JWT.split(".")).toHaveLength(3);
  });

  it("redacts values of secret-looking flags in all shapes", () => {
    const argv = ["node", "server.js", "--token", SECRETS[5]!, "--api-key=" + SECRETS[0], "-p", "3000", "PASSWORD=" + SECRETS[5], "--auth-cookie", "session=abc"];
    const out = redactArgv(argv, HOME);
    expect(out).toEqual(["node", "server.js", "--token", "[redacted]", "--api-key=[redacted]", "-p", "3000", "PASSWORD=[redacted]", "--auth-cookie", "[redacted]"]);
  });

  it("redacts URL credentials and bearer values", () => {
    expect(redactArgv(["curl", "https://user:pa55@example.com/x"], HOME)).toEqual(["curl", "https://[redacted]@example.com/x"]);
    expect(redactArgv(["curl", "-H", `Authorization: Bearer ${SYNTHETIC_BEARER_VALUE}`], HOME)[2]).toBe("Authorization: [redacted]");
    expect(redactArgv(["psql", "postgres://admin:s3cret@db:5432/app"], HOME)[1]).toBe("postgres://[redacted]@db:5432/app");
  });

  it("redacts well-known token formats even without a flag", () => {
    for (const secret of SECRETS.slice(0, 5)) {
      const out = displayCommand(["tool", secret], HOME);
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted]");
    }
    const jwt = SECRETS[4]!;
    expect(displayCommand(["node", "-e", jwt], HOME)).not.toContain(jwt.slice(0, 20));
    const npmToken = SECRETS[6]!;
    expect(displayCommand(["npm", "publish", npmToken], HOME)).not.toContain(npmToken);
  });

  it("collapses home paths to ~ and bounds the display command", () => {
    expect(homeRelative("/home/alice/app", HOME)).toBe("~/app");
    expect(homeRelative("/home/alice", HOME)).toBe("~");
    expect(homeRelative("/home/alicex/app", HOME)).toBe("/home/alicex/app");
    expect(homeRelative("/tmp/x", HOME)).toBe("/tmp/x");
    expect(displayCommand(["node", "/home/alice/app/server.js", "--root=/home/alice/site"], HOME)).toBe("node ~/app/server.js --root=~/site");
    const long = displayCommand(["node", ...Array.from({ length: 200 }, (_, i) => `--flag${i}`)], HOME);
    expect(long.length).toBeLessThanOrEqual(DISPLAY_COMMAND_MAX);
    expect(long.endsWith("…")).toBe(true);
  });

  it("quotes arguments containing spaces", () => {
    expect(displayCommand(["echo", "hello world"], HOME)).toBe('echo "hello world"');
  });

  it("derives a display name from argv[0] or comm", () => {
    expect(displayName(["/usr/bin/node", "x.js"], "node")).toBe("node");
    expect(displayName([], "Paseo Daemon")).toBe("Paseo Daemon");
    expect(displayName(["-bash"], "bash")).toBe("bash");
  });

  it("hashes argv stably and distinguishes boundaries", () => {
    expect(hashArgv(["a", "b"])).toBe(hashArgv(["a", "b"]));
    expect(hashArgv(["a", "b"])).not.toBe(hashArgv(["ab"]));
    expect(hashArgv(["a", "b"])).not.toBe(hashArgv(["a", "b", ""]));
    expect(hashArgv(["node", SECRETS[0]!])).not.toContain(SECRETS[0]!.slice(0, 12));
  });
});
