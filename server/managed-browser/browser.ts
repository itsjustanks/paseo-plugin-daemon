import { setTimeout } from "./node-timers";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type {
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
import type { BrowserVideoReadInput, BrowserVideoReadReply } from "../../shared/managed-browser/browser-video";
import { createBrowserOperationDiagnostics } from "./browser-operation-diagnostics";
import { resolveBrowserRuntimeAssets, privateBrowserEnvironment } from "./runtime-path";
import type { JsonValue } from "./runtime-protocol";
import { resolveSupervisorPaths } from "./supervisor-paths";
import { SupervisorClient } from "./supervisor-client";

export type {
  BrowserRuntimeClient,
  SessionManagerOptions,
  WorkspaceValidator,
} from "./browser-policy";

type AttachInput = RpcInput<typeof attachBrowserRpc>;
type AttachOutput = RpcOutput<typeof attachBrowserRpc>;
type DetachInput = RpcInput<typeof detachBrowserRpc>;
type DetachOutput = RpcOutput<typeof detachBrowserRpc>;
type DensityInput = RpcInput<typeof setCaptureDensityRpc>;
type DensityOutput = RpcOutput<typeof setCaptureDensityRpc>;
type CaptureInput = RpcInput<typeof captureBrowserRpc>;
type CaptureOutput = RpcOutput<typeof captureBrowserRpc>;
type CloseInput = RpcInput<typeof closeBrowserRpc>;
type CloseOutput = RpcOutput<typeof closeBrowserRpc>;
type CloseTabInput = RpcInput<typeof closeBrowserTabRpc>;
type CloseTabOutput = RpcOutput<typeof closeBrowserTabRpc>;
type CreateTabOutput = RpcOutput<typeof createBrowserTabRpc>;
type ListTabsOutput = RpcOutput<typeof listBrowserTabsRpc>;
type ReopenInput = RpcInput<typeof reopenBrowserRpc>;
type ReopenOutput = RpcOutput<typeof reopenBrowserRpc>;
type AcquireControlInput = RpcInput<typeof acquireControlRpc>;
type AcquireControlOutput = RpcOutput<typeof acquireControlRpc>;
type ReleaseControlInput = RpcInput<typeof releaseControlRpc>;
type ReleaseControlOutput = RpcOutput<typeof releaseControlRpc>;
type ListOpenOutput = RpcOutput<typeof listOpenBrowserWorkspacesRpc>;
type NavigateInput = RpcInput<typeof navigateBrowserRpc>;
type NavigateOutput = RpcOutput<typeof navigateBrowserRpc>;
type ResizeInput = RpcInput<typeof resizeBrowserRpc>;
type ResizeOutput = RpcOutput<typeof resizeBrowserRpc>;
type ApplyDevicePresetInput = RpcInput<typeof applyDevicePresetRpc>;
type ApplyDevicePresetOutput = RpcOutput<typeof applyDevicePresetRpc>;
type SendInput = RpcInput<typeof sendBrowserInputRpc>;
type SendOutput = RpcOutput<typeof sendBrowserInputRpc>;
type BeginGestureInput = RpcInput<typeof beginBrowserGestureRpc>;
type BeginGestureOutput = RpcOutput<typeof beginBrowserGestureRpc>;
type UpdateGestureInput = RpcInput<typeof updateBrowserGestureRpc>;
type UpdateGestureOutput = RpcOutput<typeof updateBrowserGestureRpc>;
type EndGestureInput = RpcInput<typeof endBrowserGestureRpc>;
type EndGestureOutput = RpcOutput<typeof endBrowserGestureRpc>;

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

class RemoteBrowserManager {
  private readonly diagnose = createBrowserOperationDiagnostics();

  private requestBrowser<Result = JsonValue>(operation: string, input: JsonValue): Promise<Result> {
    return this.diagnose(operation, () => this.client.requestBrowser<Result>(operation, input));
  }

  constructor(private readonly client: SupervisorClient) {}

  async connect(): Promise<void> {
    await this.client.connect();
  }

  attach(workspaceId: string, viewerLabel: string, tabId?: string, create = false): Promise<AttachOutput> {
    return this.requestBrowser<AttachOutput>("attach", {
      workspaceId,
      viewerLabel,
      create,
      ...(tabId ? { tabId } : {}),
    });
  }

  listTabs(viewerToken: string): Promise<ListTabsOutput> {
    return this.requestBrowser<ListTabsOutput>("tabs.list", { viewerToken });
  }

  createTab(viewerToken: string): Promise<CreateTabOutput> {
    return this.requestBrowser<CreateTabOutput>("tabs.create", { viewerToken });
  }

  closeTab(input: CloseTabInput): Promise<CloseTabOutput> {
    return this.requestBrowser<CloseTabOutput>("tabs.close", input);
  }

  detach(viewerToken: string): Promise<DetachOutput> {
    return this.requestBrowser<DetachOutput>("detach", { viewerToken });
  }

  close(input: CloseInput): Promise<CloseOutput> {
    return this.requestBrowser<CloseOutput>("close", input);
  }

  reopen(workspaceId: string): Promise<ReopenOutput> {
    return this.requestBrowser<ReopenOutput>("reopen", { workspaceId });
  }

  capture(
    viewerToken: string,
    quality: CaptureInput["quality"],
    knownFrameId: string | null,
  ): Promise<CaptureOutput> {
    return this.requestBrowser<CaptureOutput>("capture", {
      viewerToken,
      quality,
      knownFrameId,
    });
  }

  readVideo(input: BrowserVideoReadInput): Promise<BrowserVideoReadReply> {
    return this.requestBrowser<BrowserVideoReadReply>("video.read", input as unknown as JsonValue);
  }

  acquireControl(viewerToken: string, takeover: boolean): Promise<AcquireControlOutput> {
    return this.requestBrowser<AcquireControlOutput>("acquire-control", {
      viewerToken,
      takeover,
    });
  }

  releaseControl(viewerToken: string, controlToken: string): Promise<ReleaseControlOutput> {
    return this.requestBrowser<ReleaseControlOutput>("release-control", {
      viewerToken,
      controlToken,
    });
  }

  navigate(input: NavigateInput): Promise<NavigateOutput> {
    return this.requestBrowser<NavigateOutput>("navigate", input as unknown as JsonValue);
  }

  resize(input: ResizeInput): Promise<ResizeOutput> {
    return this.requestBrowser<ResizeOutput>("viewport", input as unknown as JsonValue);
  }

  setCaptureDensity(input: DensityInput): Promise<DensityOutput> {
    return this.requestBrowser<DensityOutput>("capture.density", input as unknown as JsonValue);
  }

  applyDevicePreset(input: ApplyDevicePresetInput): Promise<ApplyDevicePresetOutput> {
    return this.requestBrowser<ApplyDevicePresetOutput>("device", input as unknown as JsonValue);
  }

  sendInput(input: SendInput): Promise<SendOutput> {
    return this.requestBrowser<SendOutput>("input", input as unknown as JsonValue);
  }

  beginGesture(input: BeginGestureInput): Promise<BeginGestureOutput> {
    return this.requestBrowser("gesture.begin", input as unknown as JsonValue);
  }

  updateGesture(input: UpdateGestureInput): Promise<UpdateGestureOutput> {
    return this.requestBrowser("gesture.update", input as unknown as JsonValue);
  }

  endGesture(input: EndGestureInput): Promise<EndGestureOutput> {
    return this.requestBrowser("gesture.end", input as unknown as JsonValue);
  }

  async listOpenWorkspaceIds(): Promise<string[]> {
    const result = await this.requestBrowser("list", {});
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !("workspaceIds" in result)
    )
      throw new Error("Supervisor returned an invalid workspace list");
    const workspaceIds = result.workspaceIds;
    if (
      !Array.isArray(workspaceIds) ||
      !workspaceIds.every((value): value is string => typeof value === "string")
    )
      throw new Error("Supervisor returned an invalid workspace list");
    return workspaceIds;
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    await this.requestBrowser("archive", { workspaceId });
  }

  issueAgentTicket(ticket: string): Promise<void> {
    return this.client.issueAgentTicket(ticket);
  }

  bindAgentTicket(ticket: string, agentId: string, workspaceId: string): Promise<void> {
    return this.client.bindAgentTicket(ticket, agentId, workspaceId);
  }

  revokeAgent(agentId: string): Promise<void> {
    return this.client.revokeAgent(agentId);
  }

  disconnect(): void {
    this.client.disconnect();
  }
}

let productionManager: RemoteBrowserManager | null = null;
let productionStart: Promise<RemoteBrowserManager> | null = null;
let productionStopped = false;

async function launchSupervisor(): Promise<void> {
  const assets = resolveBrowserRuntimeAssets(paseoHome());
  const supervisorPath = assets.supervisor;
  try {
    await access(supervisorPath);
  } catch {
    throw new Error(`Shared Browser supervisor runtime is missing: ${supervisorPath}`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(assets.node, [supervisorPath], {
      detached: true,
      stdio: "ignore",
      env: { ...privateBrowserEnvironment(process.env), PASEO_HOME: paseoHome() },
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

async function getProductionManager(): Promise<RemoteBrowserManager> {
  if (productionStopped) throw new Error("Shared Browser plugin is stopping");
  if (productionManager) return productionManager;
  productionStart ??= (async () => {
    const manager = new RemoteBrowserManager(
      new SupervisorClient({ bridgeId: randomUUID(), paths: resolveSupervisorPaths(paseoHome()) }),
    );
    try {
      await manager.connect();
    } catch {
      await launchSupervisor();
      let lastError: unknown;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          await manager.connect();
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
    }
    if (productionStopped) {
      manager.disconnect();
      throw new Error("Shared Browser plugin is stopping");
    }
    productionManager = manager;
    return manager;
  })();
  try {
    return await productionStart;
  } finally {
    productionStart = null;
  }
}

export async function issueAgentTicket(ticket: string): Promise<void> {
  await (await getProductionManager()).issueAgentTicket(ticket);
}

export async function bindAgentTicket(
  ticket: string,
  agentId: string,
  workspaceId: string,
): Promise<void> {
  await (await getProductionManager()).bindAgentTicket(ticket, agentId, workspaceId);
}

export async function revokeAgentBrowserAccess(agentId: string): Promise<void> {
  await (await getProductionManager()).revokeAgent(agentId);
}

export async function handleAttachBrowser(
  input: AttachInput,
  context: PluginHandlerContext,
): Promise<AttachOutput> {
  const workspace = await context.paseo.workspaces.ref(input.workspaceId).refresh();
  if (!workspace) throw new Error("Workspace not found");
  return (await getProductionManager()).attach(input.workspaceId, input.viewerLabel, input.tabId, input.create);
}

export async function handleListBrowserTabs({
  viewerToken,
}: {
  viewerToken: string;
}): Promise<ListTabsOutput> {
  return (await getProductionManager()).listTabs(viewerToken);
}

export async function handleCreateBrowserTab({
  viewerToken,
}: {
  viewerToken: string;
}): Promise<CreateTabOutput> {
  return (await getProductionManager()).createTab(viewerToken);
}

export async function handleCloseBrowserTab(input: CloseTabInput): Promise<CloseTabOutput> {
  return (await getProductionManager()).closeTab(input);
}

export async function handleDetachBrowser({ viewerToken }: DetachInput): Promise<DetachOutput> {
  return (await getProductionManager()).detach(viewerToken);
}

export async function handleCloseBrowser(input: CloseInput): Promise<CloseOutput> {
  return (await getProductionManager()).close(input);
}

export async function handleReopenBrowser(
  input: ReopenInput,
  context: PluginHandlerContext,
): Promise<ReopenOutput> {
  const workspace = await context.paseo.workspaces.ref(input.workspaceId).refresh();
  if (!workspace) throw new Error("Workspace not found");
  return (await getProductionManager()).reopen(input.workspaceId);
}

export async function handleWorkspaceArchived(workspaceId: string): Promise<void> {
  if (productionStopped) return;
  await (await getProductionManager()).archiveWorkspace(workspaceId);
}

export async function handleListOpenBrowserWorkspaces(): Promise<ListOpenOutput> {
  return { workspaceIds: await (await getProductionManager()).listOpenWorkspaceIds() };
}

export async function handleCaptureBrowser({
  viewerToken,
  quality,
  knownFrameId,
}: CaptureInput): Promise<CaptureOutput> {
  return (await getProductionManager()).capture(viewerToken, quality, knownFrameId);
}

export async function handleAcquireControl({
  viewerToken,
  takeover,
}: AcquireControlInput): Promise<AcquireControlOutput> {
  return (await getProductionManager()).acquireControl(viewerToken, takeover);
}

export async function handleReleaseControl({
  viewerToken,
  controlToken,
}: ReleaseControlInput): Promise<ReleaseControlOutput> {
  return (await getProductionManager()).releaseControl(viewerToken, controlToken);
}

export async function handleNavigateBrowser(input: NavigateInput): Promise<NavigateOutput> {
  return (await getProductionManager()).navigate(input);
}

export async function handleResizeBrowser(input: ResizeInput): Promise<ResizeOutput> {
  return (await getProductionManager()).resize(input);
}

export async function handleSetCaptureDensity(input: DensityInput): Promise<DensityOutput> {
  return (await getProductionManager()).setCaptureDensity(input);
}

export async function handleApplyDevicePreset(
  input: ApplyDevicePresetInput,
): Promise<ApplyDevicePresetOutput> {
  return (await getProductionManager()).applyDevicePreset(input);
}

export async function handleSendBrowserInput(input: SendInput): Promise<SendOutput> {
  return (await getProductionManager()).sendInput(input);
}

/** Human-viewer live gestures use the existing authenticated supervisor, never an agent ticket. */
export async function handleBeginBrowserGesture(
  input: BeginGestureInput,
): Promise<BeginGestureOutput> {
  return (await getProductionManager()).beginGesture(input);
}

export async function handleUpdateBrowserGesture(
  input: UpdateGestureInput,
): Promise<UpdateGestureOutput> {
  return (await getProductionManager()).updateGesture(input);
}

export async function handleEndBrowserGesture(input: EndGestureInput): Promise<EndGestureOutput> {
  return (await getProductionManager()).endGesture(input);
}

export async function cleanupBrowserServer(): Promise<void> {
  productionStopped = true;
  if (productionStart) await productionStart.catch(() => undefined);
  productionManager?.disconnect();
  productionManager = null;
}

/** Read bounded native video without acquiring control or exposing another transport. */
export async function handleReadBrowserVideo(
  input: BrowserVideoReadInput,
): Promise<BrowserVideoReadReply> {
  return (await getProductionManager()).readVideo(input);
}
