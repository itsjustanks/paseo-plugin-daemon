/** Density changes physical capture pixels, never CSS layout or pointer coordinates. */
import { z } from "zod";
import { MAX_VIEWPORT } from "./viewport-limits";
export const captureDensitySchema = z.union([z.literal(1), z.literal(2)]);
export type CaptureDensity = z.infer<typeof captureDensitySchema>;

/** UI and server share the exact bound; an unsupported choice must not resize the page. */
export function canUseCaptureDensity(
  viewport: { width: number; height: number },
  density: CaptureDensity,
): boolean {
  return (
    viewport.width * density <= MAX_VIEWPORT.width &&
    viewport.height * density <= MAX_VIEWPORT.height
  );
}
