import { accessSync, constants, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";

export function resolveBrowserRuntimeRoot(paseoHome: string): string {
  const pluginDataRoot = join(paseoHome, "plugin-data", "daemon-link", "browser");
  let directory: string;
  try {
    directory = readFileSync(join(pluginDataRoot, "runtime-current"), "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return join(pluginDataRoot, "runtime");
    throw error;
  }
  if (
    !/^\.runtime-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      directory,
    )
  ) {
    throw new Error("Shared Browser runtime pointer is invalid");
  }
  return join(pluginDataRoot, directory);
}

export interface BrowserRuntimeAssets {
  root: string;
  node: string;
  supervisor: string;
  mcp: string;
}
export function resolveBrowserRuntimeAssets(paseoHome: string): BrowserRuntimeAssets {
  const root = resolveBrowserRuntimeRoot(paseoHome);
  const assets = { root, node: join(root, "node", "bin", "node"),
    supervisor: join(root, "supervisor.cjs"), mcp: join(root, "hosts-browser-mcp.cjs") };
  try {
    if (lstatSync(root).isSymbolicLink()) throw new Error("Runtime root must be a directory");
    accessSync(assets.node, constants.X_OK);
    accessSync(assets.supervisor, constants.R_OK);
    accessSync(assets.mcp, constants.R_OK);
  } catch {
    throw new Error("Workspace browser is not prepared on this host. Run the Hosts plugin build to prepare its private runtime.");
  }
  return assets;
}

/** Do not inherit loader injection into the independent pinned interpreter. */
export function privateBrowserEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NODE_OPTIONS: _options, NODE_PATH: _path, ELECTRON_RUN_AS_NODE: _electron, ...clean } = environment;
  return clean;
}
