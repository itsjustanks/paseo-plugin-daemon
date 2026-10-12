import { resolveToolProvider } from "../cross-daemon/agent-injection.server";
import { setTimeout, clearTimeout } from "./node-timers";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  bindAgentTicket,
  cleanupBrowserServer,
  handleAcquireControl,
  handleApplyDevicePreset,
  handleAttachBrowser,
  handleBeginBrowserGesture,
  handleCaptureBrowser,
  handleCloseBrowser,
  handleCloseBrowserTab,
  handleCreateBrowserTab,
  handleDetachBrowser,
  handleEndBrowserGesture,
  handleListBrowserTabs,
  handleListOpenBrowserWorkspaces,
  handleNavigateBrowser,
  handleReleaseControl,
  handleReopenBrowser,
  handleResizeBrowser,
  handleSendBrowserInput,
  handleSetCaptureDensity,
  handleUpdateBrowserGesture,
  handleWorkspaceArchived,
  issueAgentTicket,
  revokeAgentBrowserAccess,
} from "./browser";
import { resolveBrowserRuntimeAssets, type BrowserRuntimeAssets } from "./runtime-path";
import {
  acquireControlRpc,
  applyDevicePresetRpc,
  attachBrowserRpc,
  beginBrowserGestureRpc,
  captureBrowserRpc,
  closeBrowserRpc,
  closeBrowserTabRpc,
  createBrowserTabRpc,
  detachBrowserRpc,
  endBrowserGestureRpc,
  listBrowserTabsRpc,
  listOpenBrowserWorkspacesRpc,
  navigateBrowserRpc,
  releaseControlRpc,
  reopenBrowserRpc,
  resizeBrowserRpc,
  sendBrowserInputRpc,
  setCaptureDensityRpc,
  updateBrowserGestureRpc,
} from "../../shared/managed-browser/browser";
import { browserDisplayPreferences } from "../../shared/managed-browser/browser-display-preferences";

const TICKET_ENV = "HOSTS_BROWSER_TICKET";
const MCP_SERVER_ID = "hosts-browser";
const TICKET_ISSUE_TIMEOUT_MS = 2_000;

async function issueTicketWithinDeadline(ticket: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  let abort: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      issueAgentTicket(ticket),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Browser ticket request cancelled"));
        signal.addEventListener("abort", abort, { once: true });
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Shared Browser ticket issuance timed out")),
          TICKET_ISSUE_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
    return !signal.aborted;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}


export function contributeManagedBrowser(server: PluginServerContext) {
  server.registerSettings(browserDisplayPreferences);
  server.handle(attachBrowserRpc, handleAttachBrowser);
  server.handle(detachBrowserRpc, handleDetachBrowser);
  server.handle(closeBrowserRpc, handleCloseBrowser);
  server.handle(closeBrowserTabRpc, handleCloseBrowserTab);
  server.handle(createBrowserTabRpc, handleCreateBrowserTab);
  server.handle(listBrowserTabsRpc, handleListBrowserTabs);
  server.handle(reopenBrowserRpc, handleReopenBrowser);
  server.handle(captureBrowserRpc, handleCaptureBrowser);
  server.handle(setCaptureDensityRpc, handleSetCaptureDensity);

  server.handle(listOpenBrowserWorkspacesRpc, handleListOpenBrowserWorkspaces);
  server.handle(acquireControlRpc, handleAcquireControl);
  server.handle(releaseControlRpc, handleReleaseControl);
  server.handle(beginBrowserGestureRpc, handleBeginBrowserGesture);
  server.handle(updateBrowserGestureRpc, handleUpdateBrowserGesture);
  server.handle(endBrowserGestureRpc, handleEndBrowserGesture);
  server.handle(navigateBrowserRpc, handleNavigateBrowser);
  server.handle(resizeBrowserRpc, handleResizeBrowser);
  server.handle(applyDevicePresetRpc, handleApplyDevicePreset);
  server.handle(sendBrowserInputRpc, handleSendBrowserInput);
  server.before("agent.create", async ({ request }, context) => {
    if (request.config.internal) return request;
    // Missing browser assets must never prevent ordinary agent creation.
    let assets: BrowserRuntimeAssets;
    try { assets = resolveBrowserRuntimeAssets(paseoHome()); } catch { return request; }
    if (request.config.mcpServers?.[MCP_SERVER_ID]) return request;
    let provider = resolveToolProvider(request.config.provider);
    if (!provider) {
      try { const { config } = await context.paseo.config.get(); provider = resolveToolProvider(request.config.provider, config.providers); }
      catch { return request; }
    }
    if (!provider || context.signal.aborted) return request;
    const ticket = randomBytes(32).toString("base64url");
    if (!(await issueTicketWithinDeadline(ticket, context.signal))) return request;
    return {
      ...request,
      env: { ...request.env, [TICKET_ENV]: ticket },
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          [MCP_SERVER_ID]: {
            type: "stdio",
            command: assets.node,
            args: [assets.mcp],
            env: {
              PASEO_HOME: paseoHome(),
              [TICKET_ENV]: ticket,
              NODE_OPTIONS: "",
              NODE_PATH: "",
            },
          },
        },
      },
    };
  });

  server.before("agent.session_open", async ({ request }) => {
    if (request.reason !== "create") return request;
    const ticket = request.env[TICKET_ENV];
    if (!ticket || request.purpose !== "interactive" || !request.workspaceId) return request;
    await bindAgentTicket(ticket, request.agentId, request.workspaceId);
    const { [TICKET_ENV]: _ticket, ...environment } = request.env;
    return { ...request, env: environment };
  });

  server.on("agent.archived", ({ agent }) => revokeAgentBrowserAccess(agent.id));

  server.on("workspace.archived", ({ workspace }) => handleWorkspaceArchived(workspace.id));

  return cleanupBrowserServer;
}
