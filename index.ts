import type { PluginContext } from "@getpaseo/plugin";
import { MonitorSurface } from "./surface.client";

/**
 * Monitor entry point (Paseo plugin contract v0.7).
 *
 * The backend track registers RPC handlers here:
 *   plugin.handle(monitorSnapshot, handleMonitorSnapshot);
 *   plugin.handle(monitorStop, handleMonitorStop);
 *   plugin.handle(monitorForceStop, handleMonitorForceStop);
 * with contracts from ./contracts.shared and handlers from ./handlers.server.
 * Until it lands, the surface renders its error state for every poll.
 */

const SURFACE_ID = "monitor";

export default function contribute(plugin: PluginContext) {
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
