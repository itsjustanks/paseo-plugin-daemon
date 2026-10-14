/** Linux-only proofs for one directly spawned display. Never enumerate the process table or signal descendants. */
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath, stat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export interface DisplayExecutable {
  path: string;
  dev: number;
  ino: number;
  sha256: string;
}
export interface DisplayProcess {
  pid: number;
  parentPid: number;
  uid: number;
  startTicks: string;
  executable: string;
  executableDev: number;
  executableIno: number;
  argvHash: string;
  children: number[];
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const displayArgvHash = (argv: readonly string[]) => digest(argv.join("\0") + "\0");

/** System prerequisite only: use a canonical, root-owned ELF outside writable search paths. */
export async function inspectDisplayExecutable(requested: string): Promise<DisplayExecutable | null> {
  if (!isAbsolute(requested)) throw new Error("Untrusted display executable");
  let path: string;
  try { path = await realpath(requested); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  for (const base of [resolve(requested), path]) {
    for (let item = base; ; item = dirname(item)) {
      const entry = await lstat(item);
      if (entry.uid !== 0 || (!entry.isSymbolicLink() && (entry.mode & 0o022) !== 0))
        throw new Error("Untrusted display executable");
      if (item === dirname(item)) break;
    }
  }
  const before = await stat(path);
  if (!before.isFile() || !(before.mode & 0o111) || (before.mode & 0o6000) || before.size > 32 * 1024 * 1024)
    throw new Error("Untrusted display executable");
  const bytes = await readFile(path);
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== bytes.length ||
      !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])))
    throw new Error("Untrusted display executable");
  return { path, dev: before.dev, ino: before.ino, sha256: digest(bytes) };
}
function parseStat(text: string, pid: number): { parentPid: number; startTicks: string } {
  if (text.length > 4096 || !text.startsWith(`${pid} (`)) throw new Error("Invalid display process");
  const end = text.lastIndexOf(")");
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || !/^\d+$/.test(fields[19] ?? "") || !/^\d+$/.test(fields[1] ?? ""))
    throw new Error("Invalid display process");
  return { parentPid: Number(fields[1]), startTicks: fields[19]! };
}
function parseUid(text: string): number {
  const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(text);
  if (text.length > 65536 || !match || new Set(match.slice(1)).size !== 1) throw new Error("Invalid display UID");
  return Number(match[1]);
}
async function directChildren(pid: number): Promise<number[]> {
  const tasks = await readdir(`/proc/${pid}/task`);
  if (!tasks.length || tasks.length > 64 || tasks.some((task) => !/^[1-9]\d*$/.test(task)))
    throw new Error("Display task bound exceeded");
  const children = new Set<number>();
  await Promise.all(tasks.map(async (task) => {
    let text: string;
    try { text = await readFile(`/proc/${pid}/task/${task}/children`, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // CONFIG_PROC_CHILDREN can omit this file on a live task. Only a vanished
      // exact task directory proves a task race rather than an unknown census.
      try { await lstat(`/proc/${pid}/task/${task}`); }
      catch (taskError) { if ((taskError as NodeJS.ErrnoException).code === "ENOENT") return; throw taskError; }
      throw new Error("Display child census is unavailable");
    }
    if (text.length > 4096) throw new Error("Display child bound exceeded");
    for (const value of text.trim().split(/\s+/).filter(Boolean)) {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid display child");
      children.add(Number(value));
    }
  }));
  if (children.size > 8) throw new Error("Display child bound exceeded");
  return [...children];
}
/** Double-read birth/executable/argv/UID around the exact child's task census. No environment reads. */
export async function readDisplayProcess(pid: number): Promise<DisplayProcess | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid display PID");
  const root = `/proc/${pid}`;
  try {
    const before = parseStat(await readFile(`${root}/stat`, "utf8"), pid);
    const [command, executable, metadata, status] = await Promise.all([
      readFile(`${root}/cmdline`, "utf8"), readlink(`${root}/exe`), stat(`${root}/exe`), readFile(`${root}/status`, "utf8"),
    ]);
    if (!command || Buffer.byteLength(command) > 8192 || !command.endsWith("\0")) throw new Error("Invalid display argv");
    const uid = parseUid(status);
    const children = await directChildren(pid);
    const [finalStat, finalCommand, finalExecutable, finalMetadata, finalStatus] = await Promise.all([
      readFile(`${root}/stat`, "utf8"), readFile(`${root}/cmdline`, "utf8"), readlink(`${root}/exe`), stat(`${root}/exe`), readFile(`${root}/status`, "utf8"),
    ]);
    const after = parseStat(finalStat, pid);
    if (before.startTicks !== after.startTicks || before.parentPid !== after.parentPid ||
        command !== finalCommand || executable !== finalExecutable || uid !== parseUid(finalStatus) ||
        metadata.dev !== finalMetadata.dev || metadata.ino !== finalMetadata.ino)
      throw new Error("Display identity changed");
    return { pid, ...after, uid, executable, executableDev: metadata.dev, executableIno: metadata.ino,
      argvHash: digest(command), children };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw error;
  }
}
export function sameDisplayProcess(expected: DisplayProcess, current: DisplayProcess): boolean {
  return (["pid", "parentPid", "uid", "startTicks", "executable", "executableDev", "executableIno", "argvHash"] as const)
    .every((key) => expected[key] === current[key]);
}
