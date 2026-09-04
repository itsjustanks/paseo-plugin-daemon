import type { PluginContext } from "@getpaseo/plugin";
import { monitorForceStop, monitorSnapshot, monitorStop } from "./contracts.shared";
import { handleMonitorForceStop, handleMonitorSnapshot, handleMonitorStop } from "./handlers.server";
import { MonitorSurface } from "./surface.client";

const SURFACE_ID = "monitor";

export default function contribute(plugin: PluginContext) {
  plugin.handle(monitorSnapshot, handleMonitorSnapshot);
  plugin.handle(monitorStop, handleMonitorStop);
  plugin.handle(monitorForceStop, handleMonitorForceStop);

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
