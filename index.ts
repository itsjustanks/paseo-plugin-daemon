import type { PluginContext } from "@getpaseo/plugin";
import { monitorForceStop, monitorSnapshot, monitorStop } from "./contracts.shared";
import { createMonitorHandlers } from "./handlers.server";
import { MonitorSurface } from "./surface.client";

const SURFACE_ID = "monitor";

export default function contribute(plugin: PluginContext) {
  const handlers = createMonitorHandlers();
  plugin.handle(monitorSnapshot, handlers.snapshot);
  plugin.handle(monitorStop, handlers.stop);
  plugin.handle(monitorForceStop, handlers.forceStop);

  plugin.addSurface(SURFACE_ID, MonitorSurface);
  plugin.addSidebarItem({ id: SURFACE_ID, title: "Monitor", icon: "Activity", surface: SURFACE_ID });
  plugin.addCommandCenterItem({
    id: "open-monitor",
    title: "Open Monitor (CPU, memory, dev servers)",
    icon: "Activity",
    keywords: ["monitor", "cpu", "memory", "pressure", "processes", "dev server", "ports", "kill", "stop"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface(SURFACE_ID);
    },
  });
  return () => {};
}
