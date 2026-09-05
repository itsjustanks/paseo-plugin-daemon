// Preview declarations copied from getpaseo/paseo contracts.ts at
// f4b209be4d81d25a6143d12d374d797d485e8faa. npm still ships 0.7.2.
// Remove this augmentation when installing the published v0.8 SDK.
// This supplies types only; it does not make v0.7 load runtime entries.
import type { ComponentType } from "react";
import type { input, output, ZodType } from "zod";
import type {
  PluginCleanup, PluginSurfaceProps, PluginSidebarContribution,
  PluginWorkspacePanelContribution, PluginCommandCenterItemContribution,
  PluginRpcContract, PluginHandlerContext, PluginWorkspaceCommandContext,
} from "@getpaseo/plugin";

declare module "@getpaseo/plugin" {
  interface PluginClientContext {
    addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): PluginCleanup;
    addSidebarItem(contribution: PluginSidebarContribution): PluginCleanup;
    addWorkspacePanel(contribution: PluginWorkspacePanelContribution): PluginCleanup;
    addCommandCenterItem(contribution: PluginCommandCenterItemContribution): PluginCleanup;
    addSlashCommand(contribution: {
      name: string; description: string; argumentHint: string; context: "workspace";
      onSubmit(context: PluginWorkspaceCommandContext & { args: string }): void | Promise<void>;
    }): PluginCleanup;
  }
  interface PluginServerContext {
    handle<I extends ZodType, O extends ZodType>(
      contract: PluginRpcContract<I, O>,
      handler: (input: output<I>, context: PluginHandlerContext) => input<O> | Promise<input<O>>,
    ): void;
  }
}
