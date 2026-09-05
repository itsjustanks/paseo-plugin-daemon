import { DarwinAdapter } from "./darwin";
import { LinuxAdapter } from "./linux";
import type { PlatformAdapter } from "./platform";

export type SupportedPlatform = "linux" | "darwin";

export function detectPlatform(platform: NodeJS.Platform = process.platform): SupportedPlatform | "unsupported" {
  if (platform === "linux" || platform === "darwin") return platform;
  return "unsupported";
}

/** The concrete adapter for this daemon, or null when the platform is unsupported. */
export function createAdapter(platform: NodeJS.Platform = process.platform): PlatformAdapter | null {
  switch (detectPlatform(platform)) {
    case "linux":
      return new LinuxAdapter();
    case "darwin":
      return new DarwinAdapter();
    default:
      return null;
  }
}
