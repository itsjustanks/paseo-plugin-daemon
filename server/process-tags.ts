/** Extract only a valid Paseo agent UUID. Never retain or log environments. */
const UUID = "[0-9a-f-]{36}";
export function parseLinuxAgentId(environ: Buffer | string): string | null {
  const text = typeof environ === "string" ? environ : environ.toString("utf8");
  for (const entry of text.slice(0, text.lastIndexOf("\0")).split("\0")) {
    const match = new RegExp(`^PASEO_AGENT_ID=(${UUID})$`).exec(entry);
    if (match) return match[1]!;
  }
  return null;
}

/** Preserve argv whitespace: attribution comes only from the exact argv suffix. */
export function parseMacAgentIds(argsOnly: string, withEnvironment: string): Map<number, string> {
  const args = new Map<number, string>();
  const lineParts = (line: string) => /^\s*(\d+) +(.*)$/.exec(line);
  for (const line of argsOnly.split("\n")) {
    const match = lineParts(line);
    if (match) args.set(Number(match[1]), match[2]!);
  }
  const ids = new Map<number, string>();
  for (const line of withEnvironment.split("\n")) {
    const match = lineParts(line);
    if (!match) continue;
    const pid = Number(match[1]), argv = args.get(pid), command = match[2]!;
    if (!argv || !command.startsWith(`${argv} `)) continue;
    // Bound each environment suffix independently, as on Linux. A cut entry is ignored.
    const suffix = command.slice(argv.length + 1);
    const environment = Buffer.from(suffix).subarray(0, 64 * 1024).toString("utf8");
    const complete = Buffer.byteLength(suffix) > 64 * 1024 ? environment.slice(0, environment.lastIndexOf(" ")) : environment;
    const tag = new RegExp(`(?:^| )PASEO_AGENT_ID=(${UUID})(?= |$)`).exec(complete);
    if (tag) ids.set(pid, tag[1]!);
  }
  return ids;
}

/** ps comm is a full path for many Mac programs, but sometimes only a short name. */
export function parseMacComms(text: string): Map<number, string> {
  const paths = new Map<number, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+) +(.+)$/.exec(line);
    if (match) paths.set(Number(match[1]), match[2]!);
  }
  return paths;
}

/** lsof lists the main executable first among each process's text mappings. */
export function parseMacExecutables(text: string): Map<number, string> {
  const paths = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (pid !== null && line.startsWith("n/") && !paths.has(pid)) paths.set(pid, line.slice(1));
  }
  return paths;
}
