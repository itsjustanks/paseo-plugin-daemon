import type { RawProcess } from "./platform";
import { isInfrastructure, isAgentTool } from "./scope";
import { isPaseoInternal, isPluginHost, isTerminalWorker } from "./jobs";

type Program = Pick<RawProcess, "argv" | "comm" | "executable">;

/** Executable identity is authoritative; argv additionally protects interpreted tools. */
export function programProtection(process: Program, platform: "linux" | "darwin"): string | null {
  const executable = process.executable;
  if (!executable?.startsWith("/")) return "Its program couldn't be verified. Refresh before trying again.";
  if (/\.app(?:\/|$)/i.test(executable)) return "A desktop app or its helper. Quit it in the app instead.";
  if (platform === "darwin" && /^\/(?:System|Library\/Apple|usr\/libexec|usr\/sbin|sbin)(?:\/|$)/.test(executable)) return "Part of macOS. Manage it in System Settings or its app.";
  if (/^(?:init|tini)$/.test(executable.split("/").pop() ?? "") || /^(?:init|tini)$/.test(process.comm)) return "A system startup process. It can't be stopped here.";
  if (isInfrastructure(process)) return "A database or system service. Stop it where it was started.";
  if (isPaseoInternal(process) || isPluginHost(process)) return "Part of Paseo, so it can't be stopped here.";
  if (isAgentTool({ ...process, argv: [executable, process.comm, ...process.argv] })) return "An agent. Stop it from its chat in Paseo.";
  return null;
}

/** Agent CLIs may start jobs. Protected services and plugin components may not. */
export function protectsDescendants(process: Program, platform: "linux" | "darwin"): boolean {
  if (isTerminalWorker(process)) return false;
  return isInfrastructure(process) || isPaseoInternal(process) || isPluginHost(process)
    || !!(process.executable && (/\.app(?:\/|$)/i.test(process.executable)
      || (platform === "darwin" && /^\/(?:System|Library\/Apple|usr\/libexec|usr\/sbin|sbin)(?:\/|$)/.test(process.executable))));
}
