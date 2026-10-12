import type { RawProcess } from "./platform";
import { isInfrastructure, isAgentTool } from "./scope";
import { isPaseoInternal, isPluginHost, isTerminalWorker } from "./jobs";

type Program = Pick<RawProcess, "argv" | "comm" | "executable">;

/** Apple's command-line Python uses an app wrapper even for a headless HTTP server. */
function pythonHttpServer(process: Program, platform: "linux" | "darwin"): boolean {
  if (platform !== "darwin" || !process.executable) return false;
  const wrapper = /\/Python3?\.framework\/Versions\/[^/]+\/Resources\/Python\.app\/Contents\/MacOS\/Python$/;
  if (!wrapper.test(process.executable) || /\.app(?:\/|$)/i.test(process.executable.replace(wrapper, ""))) return false;
  return /^(?:python[\d.]*|Python)$/.test(process.argv[0]?.split("/").pop() ?? "")
    && process.argv[1] === "-m" && process.argv[2] === "http.server";
}

/** Executable identity is authoritative; argv additionally protects interpreted tools. */
export function programProtection(process: Program, platform: "linux" | "darwin"): string | null {
  const executable = process.executable;
  if (!executable?.startsWith("/")) return "Its program couldn't be verified. Refresh before trying again.";
  if (/\.app(?:\/|$)/i.test(executable) && !pythonHttpServer(process, platform)) return "A desktop app or its helper. Quit it in the app instead.";
  if (platform === "darwin" && /^\/(?:System|Library\/Apple|usr\/libexec|usr\/sbin|sbin)(?:\/|$)/.test(executable)) return "Part of macOS. Manage it in System Settings or its app.";
  if (/^(?:init|tini)$/.test(executable.split("/").pop() ?? "") || /^(?:init|tini)$/.test(process.comm)) return "A system startup process. It can't be stopped here.";
  if (isInfrastructure(process)) return "A database or system service. Stop it where it was started.";
  if (isPaseoInternal(process) || isPluginHost(process)) return "Part of Paseo, so it can't be stopped here.";
  if (isAgentTool({ ...process, argv: [executable, process.comm, ...process.argv] })) return "An agent. Stop it from its chat in Paseo.";
  return null;
}

/**
 * Agent CLIs themselves are protected, but their dev servers, builds and scripts
 * are intentionally stoppable. Paseo descendant protection covers its internal
 * workers and plugin hosts, never an agent's work. Terminal workers protect the
 * interactive shell via the direct-parent rule; jobs launched from it stay eligible.
 */
export function protectsDescendants(process: Program, platform: "linux" | "darwin"): boolean {
  if (isInfrastructure(process) || isPluginHost(process)) return true;
  // A bundled agent executable is still an agent, even inside Paseo.app.
  if (isAgentTool({ ...process, argv: [] }) || isTerminalWorker(process)) return false;
  return isPaseoInternal(process)
    || !!(process.executable && (/\.app(?:\/|$)/i.test(process.executable)
      || (platform === "darwin" && /^\/(?:System|Library\/Apple|usr\/libexec|usr\/sbin|sbin)(?:\/|$)/.test(process.executable))));
}
