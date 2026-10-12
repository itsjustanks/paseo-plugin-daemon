import { describe, expect, it } from "vitest";
import {
  createEmulationChoices,
  localEmulationMode,
  matchingResolutionPresetId,
  selectionMode,
} from "./browser-emulation-mode";

describe("device defaults for shared emulation", () => {
  it("uses actual platform/browser device hints, not narrow layout", () => {
    expect(localEmulationMode({ platform: "web", userAgent: "Desktop Chrome" })).toBe("desktop");
    expect(localEmulationMode({ platform: "web", userAgent: "Android Mobile Chrome" })).toBe(
      "mobile",
    );
    expect(localEmulationMode({ platform: "web", mobile: true })).toBe("mobile");
    expect(
      localEmulationMode({ platform: "web", userAgent: "Macintosh Safari", maxTouchPoints: 5 }),
    ).toBe("mobile");
    expect(
      localEmulationMode({ platform: "web", userAgent: "Windows Chrome", maxTouchPoints: 10 }),
    ).toBe("desktop");
    expect(localEmulationMode({ platform: "ios" })).toBe("mobile");
    expect(localEmulationMode({ platform: "android" })).toBe("mobile");
  });
  it("applies a different local mode once, then honors explicit choices across reacquisition", () => {
    const choices = createEmulationChoices({ platform: "ios" });
    expect(choices.claimDefault("desktop")).toEqual({
      presetId: "iphone-15-pro",
      preserveDisplay: true,
    });
    expect(choices.claimDefault("desktop")).toBeNull();
  });
  it("keeps an already matching mode and never replays a remembered viewport on toggle", () => {
    const choices = createEmulationChoices({ platform: "web" });
    choices.remember(null);
    expect(choices.claimDefault("desktop")).toBeNull();
    expect(choices.toggle("desktop")).toEqual({ presetId: "pixel-7-sharp", preserveDisplay: true });
    expect(choices.toggle("mobile")).toEqual({
      presetId: "desktop-chrome",
      preserveDisplay: true,
    });
    expect(selectionMode(null)).toBe("desktop");
    expect(selectionMode("pixel-7")).toBe("mobile");
  });
  it("remembers behavior profiles without claiming their native dimensions", () => {
    const choices = createEmulationChoices({ platform: "web" });
    choices.remember("desktop-1920x1080");
    choices.remember("iphone-15-pro");
    expect(choices.toggle("desktop")).toEqual({ presetId: "iphone-15-pro", preserveDisplay: true });
    expect(choices.toggle("mobile")).toEqual({
      presetId: "desktop-1920x1080",
      preserveDisplay: true,
    });
    expect(
      matchingResolutionPresetId({
        devicePresetId: "iphone-15-pro",
        viewport: { width: 1920, height: 1080 },
        captureScale: 1,
      }),
    ).toBeNull();
  });
  it("checks exact viewport and capture density in resolution selection", () => {
    const base = {
      devicePresetId: "pixel-7-sharp" as const,
      viewport: { width: 412, height: 839 },
      captureScale: 2,
    };
    expect(matchingResolutionPresetId(base)).toBe("pixel-7-sharp");
    expect(matchingResolutionPresetId({ ...base, captureScale: 1 })).toBeNull();
    expect(
      matchingResolutionPresetId({ ...base, viewport: { width: 1920, height: 1200 } }),
    ).toBeNull();
    expect(matchingResolutionPresetId(null)).toBeNull();
  });
});
