// Intentionally builtins-only: this entry runs before any Node >=24 dependency.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARTIFACTS, NODE_VERSION, artifactsFor } from "./artifacts.mjs";

export function privateEnvironment(source, nodeDirectory) {
  const clean = Object.fromEntries(Object.entries(source).filter(([name]) =>
    !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|npm_config_node_options|npm_config_prefix|npm_config_global)$/i.test(name)));
  return { ...clean, PATH: `${nodeDirectory}:${clean.PATH ?? ""}` };
}
export async function run(executable, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Browser preparation command failed (${signal ?? code})`)));
  });
}
export async function verifyFile(path, expected, maxBytes) {
  if ((await stat(path)).size > maxBytes) throw new Error("Browser artifact exceeded its size bound");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error("Browser artifact SHA-256 mismatch; nothing was executed");
}
export async function downloadVerified(url, path, expected, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`Browser artifact download failed: HTTP ${response.status}`);
  const file = await open(path, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error("Browser artifact exceeded its size bound");
      await file.write(chunk);
    }
  } finally { await file.close(); }
  await verifyFile(path, expected, maxBytes);
}

export async function bootstrap() {
  const pins = artifactsFor();
  if (!process.env.PASEO_HOME) throw new Error("PASEO_HOME must identify the host being prepared");
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const root = join(resolve(process.env.PASEO_HOME), "plugin-data", "daemon-link", "browser");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  // One install at a time. A failed preparation never publishes the new pointer.
  const lockPath = join(root, "prepare.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const stage = join(root, `.runtime-${randomUUID()}`);
  let prepared = false;
  try {
    await mkdir(stage, { mode: 0o700 });
    const archive = join(stage, "node.tar.gz");
    await downloadVerified(pins.nodeUrl, archive, pins.node, 100 * 1024 * 1024);
    await mkdir(join(stage, "node"), { mode: 0o700 });
    await run("tar", ["-xzf", archive, "--strip-components=1", "-C", join(stage, "node")]);
    await rm(archive);
    const node = join(stage, "node", "bin", "node");
    const env = privateEnvironment(process.env, dirname(node));
    const check = `if(process.version!==${JSON.stringify(`v${NODE_VERSION}`)}||process.platform!==${JSON.stringify(process.platform)}||process.arch!==${JSON.stringify(process.arch)})process.exit(1)`;
    await run(node, ["-e", check], { env });
    console.log(`Preparing browser with private Node ${NODE_VERSION}; bootstrap Node ${process.version}`);
    await run(node, [join(stage, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      "ci", "--ignore-scripts", "--include=dev", "--include=optional", "--no-audit", "--no-fund",
      "--cache", join(stage, "npm-cache")], { cwd: project, env });
    await run(node, [join(project, "scripts/browser/prepare.mjs"), stage], { cwd: project, env });
    prepared = true;
  } finally {
    if (!prepared) await rm(stage, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  bootstrap().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
