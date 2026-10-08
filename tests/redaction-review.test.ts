import { describe, expect, it } from "vitest";
import { displayCommand, isSecretName, redactArgv, redactSecrets } from "../shared/redaction";

/** 0.15.0 review (Sol): quoted values, any-scheme Authorization, structural flags, whole-name matching. */

const R = "[redacted]";
const hidden = (text: string, ...secrets: string[]) => {
  const out = redactSecrets(text);
  for (const secret of secrets) expect(out, `${text} → ${out}`).not.toContain(secret);
  return out;
};

describe("quoted values mask the whole quoted span", () => {
  it("double, single, JSON, colon, unterminated", () => {
    expect(hidden('password="correct horse battery staple" next', "correct", "horse", "battery", "staple")).toMatch(/^password="?\[redacted\]"? next$/);
    expect(hidden("token='a b c' rest", "a b c")).toMatch(/^token='?\[redacted\]'? rest$/);
    expect(hidden('{"client_secret": "two words", "user": "alice"}', "two words")).toContain('"user": "alice"');
    hidden('secret: "very long phrase here"', "very", "phrase");
    hidden('API_KEY="unterminated value to the end', "unterminated", "value", "end");
    expect(redactSecrets('note="just words" title="hello there"')).toBe('note="just words" title="hello there"');
  });
});

describe("Authorization with any scheme, any case, short values", () => {
  for (const line of ["Authorization: Bearer abc", "authorization: token x1", "AUTHORIZATION: Digest username=a", "Authorization: Basic Zm9v", "Proxy-Authorization: Negotiate q", 'curl -H "Authorization: Custom v" https://x', '{"authorization": "Bearer short"}']) {
    it(line, () => {
      const out = redactSecrets(line);
      expect(out).toMatch(/authorization["']?\s*[:=]\s*["']?\[redacted\]/i);
      for (const value of ["abc", "x1", "username=a", "Zm9v", "Negotiate q", "Custom v", "short"]) if (line.includes(value)) expect(out, out).not.toContain(value);
    });
  }
});

describe("structural flag/value pairs, in strings and argv", () => {
  const flags = ["--api-key", "--token", "--password", "--secret", "--auth", "--bearer"];
  for (const flag of flags) {
    it(`${flag} X, ${flag}=X, and quoted`, () => {
      expect(hidden(`tool ${flag} s3cr3tV4lue run`, "s3cr3tV4lue")).toBe(`tool ${flag} ${R} run`);
      expect(hidden(`tool ${flag}=s3cr3tV4lue run`, "s3cr3tV4lue")).toBe(`tool ${flag}=${R} run`);
      hidden(`tool ${flag} "two words" run`, "two", "words");
      expect(redactArgv(["tool", flag, "s3cr3tV4lue"], "/home/alice")).toEqual(["tool", flag, R]);
      expect(redactArgv(["tool", `${flag}=s3cr3tV4lue`], "/home/alice")).toEqual(["tool", `${flag}=${R}`]);
    });
  }
  it("FOO_TOKEN=X, in a string and in argv", () => {
    expect(hidden("FOO_TOKEN=abcd1234 node app.js", "abcd1234")).toBe(`FOO_TOKEN=${R} node app.js`);
    expect(displayCommand(["env", "FOO_TOKEN=abcd1234", "node"], "/home/alice")).toBe(`env FOO_TOKEN=${R} node`);
  });
});

describe("whole-name matching", () => {
  it("secret names", () => {
    for (const name of ["token", "secret", "password", "passwd", "api_key", "apikey", "api-key", "apiKey", "auth", "authorization", "bearer", "client_secret", "access_token", "refresh_token", "private_key", "GITHUB_TOKEN", "JWT_SECRET", "x-auth-token", "PGPASSWORD", "--api-key", "x-api-key"]) expect(isSecretName(name), name).toBe(true);
  });
  it("ordinary names stay visible", () => {
    for (const name of ["tokenizer", "monkey", "keyboard", "author", "authors", "max_tokens", "secretary", "passenger", "signal", "keys_count"]) expect(isSecretName(name), name).toBe(false);
    expect(redactSecrets("tokenizer=bpe author=alice keyboard=us monkey=1 --author bob")).toBe("tokenizer=bpe author=alice keyboard=us monkey=1 --author bob");
  });
});
