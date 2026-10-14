import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { z } from "zod";
import { BROWSER_RUNTIME_UPGRADE_REQUIRED } from "../../shared/managed-browser/browser-runtime-upgrade";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const processBinding = z.object({ pid: z.number().int().positive(), uid: z.number().int().nonnegative(), birth: z.string().min(1).max(128), argvHash: digest, executable: z.string().min(1).max(4096) }).strict();
const directoryBinding = z.object({ path: z.string().max(4096), dev: z.number(), ino: z.number(), uid: z.number(), mode: z.number().int() }).strict();
export const upgradeBindingSchema = z.object({
  owner: processBinding, worker: processBinding, plugin: processBinding,
  runtime: z.string().min(1).max(4096), homeHash: digest, endpointHash: digest,
  assetHashes: z.record(z.string(), digest), profiles: z.array(directoryBinding).max(10000),
  descendants: z.array(processBinding).max(4096),
}).strict();
export type UpgradeBinding = z.output<typeof upgradeBindingSchema>;
const receiptSchema = z.object({
  version: z.literal(1), operationId: z.string().uuid(), protocolFrom: z.literal(2), protocolTo: z.literal(3),
  status: z.enum(["in-progress", "unknown", "verified", "not-sent"]), createdAt: z.number().int(),
  binding: upgradeBindingSchema,
}).strict();
export type UpgradeReceipt = z.output<typeof receiptSchema>;

export function browserDataRoot(home: string): string { return join(resolve(home), "plugin-data", "daemon-link", "browser"); }

/** Never follow a substituted private path. No file contents or paths enter RPC errors. */
export function ownedMetadata(home: string, file: string, type: "file" | "directory" | "socket", mode?: number) {
  const base = resolve(home), suffix = relative(base, file);
  if (suffix.startsWith("..") || suffix.startsWith(sep)) throw new Error("Private browser path is outside its home");
  const paths = [base];
  for (const part of suffix.split(sep).filter(Boolean)) paths.push(join(paths[paths.length - 1]!, part));
  for (const [index, path] of paths.entries()) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (index < paths.length - 1 && (!stat.isDirectory() || (stat.mode & 0o022) !== 0))) throw new Error("Private browser path ownership is unverified");
  }
  const stat = lstatSync(file);
  if (!(type === "directory" ? stat.isDirectory() : type === "socket" ? stat.isSocket() : stat.isFile()) || (mode !== undefined && (stat.mode & 0o777) !== mode)) throw new Error("Private browser metadata is invalid");
  return stat;
}

export function readPrivateFile(home: string, file: string, maxBytes = 64 * 1024): Buffer {
  const stat = ownedMetadata(home, file, "file", 0o600);
  if (stat.size > maxBytes) throw new Error("Private browser metadata exceeds its bound");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = fstatSync(fd);
    if (first.dev !== stat.dev || first.ino !== stat.ino || first.size > maxBytes) throw new Error("Private browser metadata changed");
    const bytes = Buffer.alloc(first.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Private browser metadata changed"); offset += count;
    }
    const last = fstatSync(fd);
    if (last.size !== first.size || last.mtimeMs !== first.mtimeMs || last.ctimeMs !== first.ctimeMs) throw new Error("Private browser metadata changed");
    return bytes;
  } finally { closeSync(fd); }
}

export class UpgradeReceiptStore {
  readonly file: string;
  readonly pending: string;
  constructor(readonly home: string) {
    this.file = join(browserDataRoot(home), "migration-v2-v3.json");
    this.pending = this.file + ".pending";
  }
  read(): UpgradeReceipt | null {
    // A partial durable write is deliberately not interpreted as permission to start.
    try { lstatSync(this.pending); throw new Error("Browser migration receipt write is unresolved"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { return receiptSchema.parse(JSON.parse(readPrivateFile(this.home, this.file, 2 * 1024 * 1024).toString("utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  write(receipt: UpgradeReceipt): void {
    const value = receiptSchema.parse(receipt);
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error("Browser migration receipt exceeds its bound");
    ownedMetadata(this.home, browserDataRoot(this.home), "directory", 0o700);
    const fd = openSync(this.pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(this.pending, this.file);
    const directory = openSync(browserDataRoot(this.home), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

export function assertUpgradeReceiptVerified(home: string): void {
  let receipt: UpgradeReceipt | null;
  try { receipt = new UpgradeReceiptStore(home).read(); }
  catch { throw new Error(`${BROWSER_RUNTIME_UPGRADE_REQUIRED}: Hosts browser restart receipt is unreadable or unresolved. Browser startup remains blocked. Recheck or seek help; no files will be deleted.`); }
  // Proven not-sent removes only the receipt barrier. The ordinary v2 listener
  // guard still prevents protocol3 admission while the previous owner is live.
  if (receipt && receipt.status !== "verified" && receipt.status !== "not-sent") throw new Error(`${BROWSER_RUNTIME_UPGRADE_REQUIRED}: Hosts browser restart is unresolved. Recheck the restart, or restart this host's container or computer and recheck. Saved profiles are retained.`);
}
