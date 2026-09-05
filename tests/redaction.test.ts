import { describe, expect, it } from "vitest";
import { DISPLAY_COMMAND_MAX, displayCommand, displayName, hashArgv, homeRelative, isSecretName, redactArgv } from "../server/redaction";
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
const R = "[redacted]";

const SECRETS = [
  SYNTHETIC_ANTHROPIC_KEY,
  SYNTHETIC_GITHUB_TOKEN,
  SYNTHETIC_AWS_ACCESS_KEY,
  SYNTHETIC_SLACK_TOKEN,
  SYNTHETIC_JWT,
  SYNTHETIC_PASSWORD,
  SYNTHETIC_NPM_TOKEN,
];

/** Plain secret values with no recognisable prefix; only context can catch them. */
const PW = "s3cret-pw-9";
const PW2 = "another-pw";

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
    expect(out).toEqual(["node", "server.js", "--token", R, "--api-key=" + R, "-p", "3000", "PASSWORD=" + R, "--auth-cookie", R]);
  });

  it("redacts URL credentials and bearer values", () => {
    expect(redactArgv(["curl", "https://user:pa55@example.com/x"], HOME)).toEqual(["curl", `https://${R}@example.com/x`]);
    expect(redactArgv(["curl", "-H", `Authorization: Bearer ${SYNTHETIC_BEARER_VALUE}`], HOME)[2]).toBe(`Authorization: ${R}`);
    expect(redactArgv(["psql", "postgres://admin:s3cret@db:5432/app"], HOME)[1]).toBe(`postgres://${R}@db:5432/app`);
  });

  it("redacts well-known token formats even without a flag", () => {
    for (const secret of SECRETS.slice(0, 5)) {
      const out = displayCommand(["tool", secret], HOME);
      expect(out).not.toContain(secret);
      expect(out).toContain(R);
    }
    const jwt = SECRETS[4]!;
    expect(displayCommand(["node", "-e", jwt], HOME)).not.toContain(jwt.slice(0, 20));
    const npmToken = SECRETS[6]!;
    expect(displayCommand(["npm", "publish", npmToken], HOME)).not.toContain(npmToken);
    const vault = "hvs." + "A1b2".repeat(7);
    const sendgrid = "SG." + "a".repeat(22) + "." + "b".repeat(43);
    const google = "ya29." + "x".repeat(40);
    for (const secret of [vault, sendgrid, google]) expect(displayCommand(["tool", secret], HOME)).toBe(`tool ${R}`);
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

describe("executable-aware credential flags", () => {
  it("curl: -u/--user, attached -u, proxy and bearer flags, secret headers", () => {
    expect(redactArgv(["curl", "-u", `alice:${PW}`, "https://h/"], HOME)).toEqual(["curl", "-u", R, "https://h/"]);
    expect(redactArgv(["curl", "--user", `alice:${PW}`, "https://h/"], HOME)).toEqual(["curl", "--user", R, "https://h/"]);
    expect(redactArgv(["curl", `-ualice:${PW}`, "https://h/"], HOME)).toEqual(["curl", `-u${R}`, "https://h/"]);
    expect(redactArgv(["curl", "--proxy-user", `p:${PW}`, "--oauth2-bearer", PW2], HOME)).toEqual(["curl", "--proxy-user", R, "--oauth2-bearer", R]);
    expect(redactArgv(["curl", "-H", `X-Api-Key: ${PW}`, "-H", "Accept: application/json"], HOME)).toEqual(["curl", "-H", `X-Api-Key: ${R}`, "-H", "Accept: application/json"]);
    expect(redactArgv(["curl", "-H", `Cookie: session=${PW}; theme=dark`], HOME)[2]).toBe(`Cookie: ${R}`);
    expect(redactArgv(["curl", "-H", `Authorization: Basic ${Buffer.from("a:b").toString("base64")}`], HOME)[2]).toBe(`Authorization: ${R}`);
    // Wrappers in front of the tool do not defeat the rule.
    expect(redactArgv(["sudo", "-E", "curl", "-u", `a:${PW}`], HOME)).toEqual(["sudo", "-E", "curl", "-u", R]);
    expect(redactArgv(["/usr/bin/env", "FOO=1", "/opt/bin/curl", `-ua:${PW}`], HOME)).toEqual(["/usr/bin/env", "FOO=1", "/opt/bin/curl", `-u${R}`]);
  });

  it("redis-cli: -a and --pass", () => {
    expect(redactArgv(["redis-cli", "-a", PW, "ping"], HOME)).toEqual(["redis-cli", "-a", R, "ping"]);
    expect(redactArgv(["redis-cli", "--pass", PW, "-h", "cache"], HOME)).toEqual(["redis-cli", "--pass", R, "-h", "cache"]);
    // `-a` is not a secret for other tools.
    expect(redactArgv(["ls", "-a", "/tmp"], HOME)).toEqual(["ls", "-a", "/tmp"]);
  });

  it("mysql/mariadb: attached -pSECRET and --password forms, but a bare -p prompt is left alone", () => {
    expect(redactArgv(["mysql", "-u", "root", `-p${PW}`, "app"], HOME)).toEqual(["mysql", "-u", "root", `-p${R}`, "app"]);
    expect(redactArgv(["mariadb", "-uroot", `-p${PW}`], HOME)).toEqual(["mariadb", "-uroot", `-p${R}`]);
    expect(redactArgv(["mysqldump", `--password=${PW}`, "app"], HOME)).toEqual(["mysqldump", `--password=${R}`, "app"]);
    expect(redactArgv(["mysql", "--password", PW], HOME)).toEqual(["mysql", "--password", R]);
    expect(redactArgv(["mysql", "-u", "root", "-p", "app"], HOME)).toEqual(["mysql", "-u", "root", "-p", "app"]);
    expect(redactArgv(["sudo", "-u", "dba", "mysql", `-p${PW}`], HOME)).toEqual(["sudo", "-u", "dba", "mysql", `-p${R}`]);
    // `-p` on an unrelated tool stays a port.
    expect(redactArgv(["node", "server.js", "-p3000"], HOME)).toEqual(["node", "server.js", "-p3000"]);
  });

  it("psql/PG and other clients: URLs, conninfo strings, env, and -p/-P/-w forms", () => {
    expect(redactArgv(["psql", `postgresql://app:${PW}@db/app?sslmode=require`], HOME)).toEqual(["psql", `postgresql://${R}@db/app?sslmode=require`]);
    expect(redactArgv(["psql", `host=db user=app password=${PW} dbname=app`], HOME)).toEqual(["psql", `host=db user=app password=${R} dbname=app`]);
    expect(redactArgv(["psql", `-dhost=db;password=${PW};sslmode=require`], HOME)).toEqual(["psql", `-dhost=db;password=${R};sslmode=require`]);
    expect(redactArgv(["mongosh", "-u", "app", "-p", PW, "--host", "db"], HOME)).toEqual(["mongosh", "-u", "app", "-p", R, "--host", "db"]);
    expect(redactArgv(["mongodump", `-p${PW}`], HOME)).toEqual(["mongodump", `-p${R}`]);
    expect(redactArgv(["sshpass", "-p", PW, "ssh", "host"], HOME)).toEqual(["sshpass", "-p", R, "ssh", "host"]);
    expect(redactArgv(["sqlcmd", "-S", "db", "-U", "sa", `-P${PW}`], HOME)).toEqual(["sqlcmd", "-S", "db", "-U", "sa", `-P${R}`]);
    expect(redactArgv(["ldapsearch", "-w", PW, "-b", "dc=x"], HOME)).toEqual(["ldapsearch", "-w", R, "-b", "dc=x"]);
    expect(redactArgv(["smbclient", "//srv/share", "-U", `bob%${PW}`], HOME)).toEqual(["smbclient", "//srv/share", "-U", R]);
    expect(redactArgv(["openssl", "enc", "-pass", `pass:${PW}`, "-k", PW2], HOME)).toEqual(["openssl", "enc", "-pass", R, "-k", R]);
    expect(redactArgv(["docker", "login", "-u", "bob", "-p", PW, "ghcr.io"], HOME)).toEqual(["docker", "login", "-u", "bob", "-p", R, "ghcr.io"]);
    // `docker run -p 8080:80` is a port mapping, not a password.
    expect(redactArgv(["docker", "run", "-p", "8080:80", "img"], HOME)).toEqual(["docker", "run", "-p", "8080:80", "img"]);
  });

  /** Every executable-specific secret flag, in `flag=value` form. `pre` covers subcommands the rule is gated on. */
  const EQUALS_FORMS: ReadonlyArray<{ exe: string; pre?: string[]; flags: string[] }> = [
    { exe: "curl", flags: ["-u", "-U", "--user", "--proxy-user", "--oauth2-bearer", "--tlspassword", "--proxy-tlspassword"] },
    { exe: "redis-cli", flags: ["-a", "--pass"] },
    { exe: "mysql", flags: ["-p"] },
    { exe: "mariadb-dump", flags: ["-p"] },
    { exe: "mongosh", flags: ["-p"] },
    { exe: "sshpass", flags: ["-p"] },
    { exe: "openssl", flags: ["-pass", "-passin", "-passout", "-k", "-K", "-kfile"] },
    { exe: "sqlcmd", flags: ["-P"] },
    { exe: "ldapsearch", flags: ["-w"] },
    { exe: "smbclient", flags: ["-U", "--user"] },
    { exe: "docker", pre: ["login"], flags: ["-p"] },
  ];

  it.each(EQUALS_FORMS)("$exe: every secret flag glued with = renders flag=[redacted]", ({ exe, pre = [], flags }) => {
    for (const flag of flags) {
      const value = `admin:${PW}`;
      expect(redactArgv([exe, ...pre, `${flag}=${value}`, "target"], HOME), `${exe} ${flag}=`).toEqual([exe, ...pre, `${flag}=${R}`, "target"]);
      // Wrapped in sudo, and with a value that itself contains `=`.
      expect(redactArgv(["sudo", exe, ...pre, `${flag}=${PW}=x`], HOME), `sudo ${exe} ${flag}=`).toEqual(["sudo", exe, ...pre, `${flag}=${R}`]);
      expect(displayCommand([exe, ...pre, `${flag}=${value}`], HOME)).not.toContain(PW);
    }
  });

  it("curl: the originally reported bypasses are closed exactly", () => {
    const pw = "S3cr3tPassword";
    expect(redactArgv(["curl", `--user=admin:${pw}`, "https://h/"], HOME)).toEqual(["curl", `--user=${R}`, "https://h/"]);
    expect(redactArgv(["curl", `--proxy-user=admin:${pw}`, "https://h/"], HOME)).toEqual(["curl", `--proxy-user=${R}`, "https://h/"]);
    expect(redactArgv(["curl", `-u=admin:${pw}`, "https://h/"], HOME)).toEqual(["curl", `-u=${R}`, "https://h/"]);
    expect(redactArgv(["ldapsearch", `-w=${pw}`], HOME)).toEqual(["ldapsearch", `-w=${R}`]);
    expect(redactArgv(["sqlcmd", `-P=${pw}`], HOME)).toEqual(["sqlcmd", `-P=${R}`]);
    expect(redactArgv(["smbclient", `-U=bob%${pw}`], HOME)).toEqual(["smbclient", `-U=${R}`]);
    // An attached secret containing `=` is redacted whole, not split at the `=`.
    expect(redactArgv(["mysql", `-p${pw}=x`], HOME)).toEqual(["mysql", `-p${R}`]);
    // An attached secret whose *value* looks like a secret name is not mistaken for a flag.
    expect(redactArgv(["mysql", "-pMySecretPw", "app"], HOME)).toEqual(["mysql", `-p${R}`, "app"]);
    expect(redactArgv(["curl", "-uadmin:token123", "https://h/"], HOME)).toEqual(["curl", `-u${R}`, "https://h/"]);
    expect(redactArgv(["mysql", `-p=${pw}`], HOME)).toEqual(["mysql", `-p=${R}`]);
  });

  it("equals forms of secret flags swallow continuation tokens in lossy mode", () => {
    expect(redactArgv(["curl", "--user=admin:my", "quoted", "pw", "-s", "https://h/"], HOME, { lossy: true })).toEqual(["curl", `--user=${R}`, "-s", "https://h/"]);
    expect(redactArgv(["curl", "--user=admin:my", "quoted", "pw", "-s", "https://h/"], HOME)).toEqual(["curl", `--user=${R}`, "quoted", "pw", "-s", "https://h/"]);
  });

  it("ordinary equals arguments of the same tools stay visible", () => {
    const sha = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad";
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const cases: string[][] = [
      ["curl", "--url=https://h/?q=hello&page=1", "--max-time=5", "--retry=3", "-X=POST", `--data=commit=${sha}`, `--header=X-Request-Id: ${uuid}`, "--user-agent=monitor/1.0", "--unix-socket=/tmp/s.sock"],
      ["mysql", "--user=root", "--port=3306", "--host=db", "-u=root", "--database=app"],
      ["mariadb", "--protocol=tcp", "--default-character-set=utf8mb4"],
      ["redis-cli", "-n=0", "--host=cache", "-p=6379", "-h=cache"],
      ["mongosh", "--host=db", "--port=27017", "-u=app"],
      ["openssl", "-in=file.pem", "-out=file.der", "-inform=PEM"],
      ["sqlcmd", "-S=db", "-U=sa", "-d=app"],
      ["ldapsearch", "-b=dc=x", "-H=ldap://h", "-D=cn=admin"],
      ["smbclient", "//srv/share", "-W=CORP", "-m=SMB3"],
      ["docker", "run", "-p=8080:80", "--name=web", "img"],
      ["docker", "login", "-u=bob", "--username=bob", "ghcr.io"],
      ["node", "server.js", `--commit=${sha}`, `--request-id=${uuid}`, "--port=3000", "-p=3000", "--user=bob"],
    ];
    for (const argv of cases) expect(redactArgv(argv, HOME), argv.join(" ")).toEqual(argv);
  });

  it("displayCommand never leaks a synthetic secret through an equals-glued executable flag", () => {
    const forms: string[][] = [
      ["curl", "--user=admin:%s"],
      ["curl", "--proxy-user=admin:%s"],
      ["curl", "-u=admin:%s"],
      ["curl", "-U=admin:%s"],
      ["curl", "--oauth2-bearer=%s"],
      ["redis-cli", "-a=%s"],
      ["mysql", "-p=%s"],
      ["mysql", "-p%s"],
      ["mongosh", "-p=%s"],
      ["sshpass", "-p=%s"],
      ["openssl", "-pass=pass:%s"],
      ["sqlcmd", "-P=%s"],
      ["ldapsearch", "-w=%s"],
      ["smbclient", "-U=bob%%%s"],
      ["docker", "login", "-p=%s"],
    ];
    for (const secret of [...SECRETS, SYNTHETIC_BEARER_VALUE, "S3cr3tPassword"]) {
      for (const form of forms) {
        const argv = form.map((part) => part.replace("%s", secret));
        const out = displayCommand(argv, HOME);
        expect(out, argv.join(" ")).not.toContain(secret);
        expect(out, argv.join(" ")).toContain(R);
      }
    }
  });
});

describe("environment-style names", () => {
  it("redacts common credential env names and DSN/connection strings", () => {
    const cases: Array<[string, string]> = [
      ["MYSQL_PWD", PW],
      ["PGPASSWORD", PW],
      ["AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
      ["GITHUB_TOKEN", PW],
      ["NPM_TOKEN", PW],
      ["JWT_SECRET", PW],
      ["DB_PASSWORD", PW],
      ["REDIS_PASS", PW],
      ["SIGNING_KEY", PW],
      ["SENTRY_DSN", `https://${PW}@o1.ingest.sentry.io/1`],
      ["DATABASE_URL", `postgres://app:${PW}@db/app`],
      ["DATABASE_URI", `mongodb://app:${PW}@db/app`],
      ["SQL_CONNECTION_STRING", `Server=db;Password=${PW}`],
      ["STRIPE_API_KEY", PW],
      ["SESSION_SECRET", PW],
      ["AUTH0_CLIENT_SECRET", PW],
    ];
    for (const [name, value] of cases) {
      expect(redactArgv(["env", `${name}=${value}`, "node", "app.js"], HOME), name).toEqual(["env", `${name}=${R}`, "node", "app.js"]);
      expect(isSecretName(name), name).toBe(true);
    }
  });

  it("leaves ordinary env names, hashes, UUIDs, ports, and paths intact", () => {
    const sha = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad";
    const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const argv = [
      "node",
      "--max-old-space-size=4096",
      "app.js",
      "--port",
      "3000",
      "--commit",
      sha,
      `--sha256=${digest}`,
      `--request-id=${uuid}`,
      "PATH=/usr/bin:/bin",
      "NODE_ENV=production",
      "KEYBOARD=us",
      "--keyboard=us",
      "MONKEY=1",
      "PASSENGER_COUNT=2",
      "PORT=8080",
      "https://example.com/search?page=2&sort=asc",
    ];
    expect(redactArgv(argv, HOME)).toEqual(argv);
    for (const name of ["PATH", "PORT", "KEYBOARD", "MONKEY", "PASSENGER", "NODE_ENV", "SIGNAL", "HOME"]) expect(isSecretName(name), name).toBe(false);
  });
});

describe("URLs, query strings, and JSON", () => {
  it("redacts secret query parameters in any position and keeps the rest", () => {
    const url = `https://api.example.com/v1/items?foo=bar&api_key=${PW}&page=2`;
    expect(redactArgv(["curl", url], HOME)).toEqual(["curl", `https://api.example.com/v1/items?foo=bar&api_key=${R}&page=2`]);
    expect(redactArgv(["curl", `https://h/?access_token=${PW}`], HOME)).toEqual(["curl", `https://h/?access_token=${R}`]);
    expect(redactArgv(["curl", `https://h/cb?code=abc&state=xyz&client_secret=${PW}#frag`], HOME)).toEqual(["curl", `https://h/cb?code=abc&state=xyz&client_secret=${R}#frag`]);
    expect(redactArgv(["curl", `--url=https://h/?x=1&token=${PW}`], HOME)).toEqual(["curl", `--url=https://h/?x=1&token=${R}`]);
    expect(redactArgv(["curl", "https://h/?q=hello&page=1"], HOME)).toEqual(["curl", "https://h/?q=hello&page=1"]);
  });

  it("redacts URL userinfo together with query secrets", () => {
    expect(redactArgv(["wget", `https://bob:${PW}@h/x?sig=${PW2}&v=1`], HOME)).toEqual(["wget", `https://${R}@h/x?sig=${R}&v=1`]);
  });

  it("redacts secret-looking JSON properties inside argv strings", () => {
    const json = `{"user":"bob","password":"${PW}","token": "${PW2}","port":5432,"apiKey":${JSON.stringify(PW)}}`;
    expect(redactArgv(["curl", "-d", json], HOME)[2]).toBe(`{"user":"bob","password":"${R}","token": "${R}","port":5432,"apiKey":"${R}"}`);
    // Unquoted values and values containing '=' are handled too.
    expect(redactArgv(["node", "-e", `{"secret":12345,"a":"b=c","token":"${PW}"}`], HOME)[2]).toBe(`{"secret":"${R}","a":"b=c","token":"${R}"}`);
    expect(redactArgv(["node", "-e", '{"name":"x","count":2}'], HOME)[2]).toBe('{"name":"x","count":2}');
  });
});

describe("lossy argv (macOS ps)", () => {
  it("redacts through the next flag boundary after a secret flag", () => {
    const argv = ["curl", "-u", "alice:my", "quoted", "pw", "-s", "https://h/"];
    expect(redactArgv(argv, HOME, { lossy: true })).toEqual(["curl", "-u", R, "-s", "https://h/"]);
    // Exact argv keeps positional tokens because they really are separate arguments.
    expect(redactArgv(argv, HOME)).toEqual(["curl", "-u", R, "quoted", "pw", "-s", "https://h/"]);
  });

  it("swallows continuation tokens after attached and --flag=value secrets", () => {
    expect(redactArgv(["mysql", "-pmy", "secret", "app"], HOME, { lossy: true })).toEqual(["mysql", `-p${R}`]);
    expect(redactArgv(["node", "--password=my", "secret", "--port", "80"], HOME, { lossy: true })).toEqual(["node", `--password=${R}`, "--port", "80"]);
    expect(redactArgv(["node", "--name=my", "app", "--port", "80"], HOME, { lossy: true })).toEqual(["node", "--name=my", "app", "--port", "80"]);
  });

  it("does not swallow anything when no secret was seen", () => {
    const argv = ["node", "/Users/alice/app/server.js", "--port", "3000"];
    expect(displayCommand(argv, "/Users/alice", { lossy: true })).toBe("node ~/app/server.js --port 3000");
  });
});
