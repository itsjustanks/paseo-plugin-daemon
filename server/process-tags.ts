/** Extract only a valid Paseo agent UUID. Never retain or log environments. */
const UUID = "[0-9a-f-]{36}";
export function parseLinuxAgentId(environ: Buffer | string): string | null {
  const text = typeof environ === "string" ? environ : environ.toString("utf8");
  for (const entry of text.split("\0")) {
    const match = new RegExp(`^PASEO_AGENT_ID=(${UUID})$`).exec(entry);
    if (match) return match[1]!;
  }
  return null;
}

/** macOS ps -Eww -axo pid=,command=, sampled once for the whole table. */
export function parseMacAgentIds(text: string): Map<number, string> {
  const ids = new Map<number, string>();
  for (const line of text.split("\n")) {
    const pid = /^\s*(\d+)\s/.exec(line);
    const tag = new RegExp(`\\bPASEO_AGENT_ID=(${UUID})\\b`).exec(line);
    if (pid && tag) ids.set(Number(pid[1]), tag[1]!);
  }
  return ids;
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
