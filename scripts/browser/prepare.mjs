// Adapted from Omer Cohen's MIT paseo-shared-browser prepare-runtime.mjs,
// daed6eb12f4156ca392f71c48e7a9ccca231ae8c. See server/managed-browser/LICENSE.txt.
// Executed only by the verified private Node, after locked --ignore-scripts install.
import { execFile } from "node:child_process";
import { chmod, copyFile, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { CHROME_VERSION, CHROME_REVISION, NODE_VERSION, artifactsFor } from "./artifacts.mjs";
import { replaceRuntime } from "./replace-runtime.mjs";
import { downloadVerified, privateEnvironment, run } from "./bootstrap.mjs";

const stage = resolve(process.argv[2]);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pins = artifactsFor();
if (process.version !== `v${NODE_VERSION}` || resolve(process.execPath) !== join(stage, "node/bin/node"))
  throw new Error("Browser preparation must use its verified private Node");
const exec = promisify(execFile);
const dependency = dirname(createRequire(import.meta.url).resolve("agent-browser/package.json"));
const agentRoot = join(stage, "node_modules/agent-browser");
await mkdir(join(agentRoot, "bin"), { recursive: true, mode: 0o700 });
for (const name of ["package.json", "bin/agent-browser.js", `bin/agent-browser-${pins.target}`])
  await copyFile(join(dependency, name), join(agentRoot, name));
await chmod(join(agentRoot, `bin/agent-browser-${pins.target}`), 0o700);
// Retain upstream notices present in the integrity-pinned dependency.
for (const name of ["LICENSE", "LICENSE.md", "NOTICE", "cli/src/native/a11y"]) {
  try { await cp(join(dependency, name), join(agentRoot, name), { recursive: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
await mkdir(join(stage, "node_modules/.bin"), { recursive: true, mode: 0o700 });
const cli = join(stage, "node_modules/.bin/agent-browser");
await writeFile(cli, '#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)\nexec "$base/node/bin/node" "$base/node_modules/agent-browser/bin/agent-browser.js" "$@"\n', { mode: 0o700 });
const env = privateEnvironment(process.env, join(stage, "node/bin"));
const { stdout: agentVersion } = await exec(cli, ["--version"], { env, timeout: 15_000 });
if (!/\b0\.38\.2\b/.test(agentVersion)) throw new Error("Expected private agent-browser 0.38.2");

const archive = join(stage, "chrome.zip");
await downloadVerified(pins.chromeUrl, archive, pins.chrome, 300 * 1024 * 1024);
await mkdir(join(stage, "chromium"), { mode: 0o700 });
await run("unzip", ["-q", archive, "-d", join(stage, "chromium")]);
await rm(archive);
const chromeRelative = process.platform === "darwin"
  ? `chrome-${pins.chromePlatform}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  : `chrome-${pins.chromePlatform}/chrome`;
const chrome = join(stage, "chromium/chrome");
await writeFile(chrome, `#!/bin/sh\nbase=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$base/${chromeRelative}" "$@"\n`, { mode: 0o700 });
const { stdout: chromeVersion } = await exec(chrome, ["--version"], { env, timeout: 15_000 });
if (!chromeVersion.includes(CHROME_VERSION)) throw new Error("Staged Chrome version does not match its artifact pin");
await build({ entryPoints: {
  supervisor: join(project, "server/managed-browser/supervisor-entry.ts"),
  "hosts-browser-mcp": join(project, "server/managed-browser/mcp-entry.ts"),
}, outdir: stage, outExtension: { ".js": ".cjs" }, bundle: true, platform: "node",
  target: "node24", format: "cjs", logLevel: "silent" });
await copyFile(join(project, "server/managed-browser/LICENSE.txt"), join(stage, "shared-browser-LICENSE.txt"));
await writeFile(join(stage, "provenance.json"), JSON.stringify({
  reference: "daed6eb12f4156ca392f71c48e7a9ccca231ae8c", node: NODE_VERSION,
  nodeUrl: pins.nodeUrl, nodeSha256: pins.node, agentBrowser: "0.38.2",
  chrome: CHROME_VERSION, chromeRevision: CHROME_REVISION,
  chromeUrl: pins.chromeUrl, chromeSha256: pins.chrome, target: pins.target,
}, null, 2) + "\n", { mode: 0o600 });
// npm and development headers are preparation-only. Keep the executable and license.
for (const name of ["npm-cache", "node/include", "node/lib", "node/share", "node/bin/npm", "node/bin/npx", "node/bin/corepack"])
  await rm(join(stage, name), { recursive: true, force: true });
async function makePrivate(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return;
  await chmod(path, metadata.isDirectory() || metadata.mode & 0o111 ? 0o700 : 0o600);
  if (metadata.isDirectory()) for (const entry of await readdir(path)) await makePrivate(join(path, entry));
}
await makePrivate(stage);
await replaceRuntime(stage, join(dirname(stage), "runtime"));
console.log(`Prepared private browser assets: ${stage}`);
