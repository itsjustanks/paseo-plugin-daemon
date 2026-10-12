import { describe, expect, it } from "vitest";
import {
  browserDisplayPreferences,
  browserDisplayPreferencesSchema,
} from "./browser-display-preferences";
import { DEVICE_PRESETS } from "./device-presets";
import {
  groupResolutionPresets,
  normalizeResolutionFavorites,
  orderedResolutionFavorites,
  toggleResolutionFavorite,
} from "./resolution-menu";

describe("resolution choices and host preferences", () => {
  it("groups the whole catalogue by viewport ratio, sorts width and retains mobile ties", () => {
    const groups = groupResolutionPresets();
    expect(groups.map((group) => group.label)).toEqual(["16:9", "16:10", "1:1", "Mobile"]);
    expect(
      groups
        .flatMap((group) => group.presets)
        .map((preset) => preset.id)
        .sort(),
    ).toEqual(DEVICE_PRESETS.map((preset) => preset.id).sort());
    for (const group of groups) {
      expect(group.presets.map((preset) => preset.viewport.width)).toEqual(
        group.presets.map((preset) => preset.viewport.width).sort((a, b) => a - b),
      );
      for (const preset of group.presets) {
        if (group.id === "mobile") expect(preset.isMobile).toBe(true);
        else {
          expect(preset.isMobile).toBe(false);
          const [width, height] = group.id.split(":").map(Number);
          if (width === undefined || height === undefined) throw new Error("Invalid ratio fixture");
          expect(preset.viewport.width * height).toBe(preset.viewport.height * width);
        }
      }
    }
    expect(groups[3]?.presets.map((preset) => preset.id)).toEqual([
      "iphone-15-pro",
      "pixel-7",
      "pixel-7-sharp",
      "ipad-pro-11",
    ]);
  });

  it("projects scrambled saved favorites in the grouped picker order without rewriting them", () => {
    const saved = Object.freeze([
      "pixel-7-sharp",
      "desktop-1440x1440",
      "desktop-1920x1200",
      "desktop-2560x1440",
      "desktop-1440x900",
      "desktop-chrome",
      "desktop-1440x810",
      "desktop-chrome",
      "retired",
    ]);
    expect(orderedResolutionFavorites(saved)).toEqual([
      "desktop-chrome",
      "desktop-1440x810",
      "desktop-2560x1440",
      "desktop-1440x900",
      "desktop-1920x1200",
      "desktop-1440x1440",
      "pixel-7-sharp",
    ]);
    expect(saved[0]).toBe("pixel-7-sharp");
    expect(saved).toHaveLength(9);
  });

  it("prunes removed favorites and duplicates without changing stable favorite order", () => {
    expect(
      normalizeResolutionFavorites([
        "retired",
        "pixel-7-sharp",
        "desktop-chrome",
        "pixel-7-sharp",
        "unknown",
      ]),
    ).toEqual(["pixel-7-sharp", "desktop-chrome"]);
    expect(normalizeResolutionFavorites(Array(100).fill("pixel-7"))).toEqual(["pixel-7"]);
    expect(
      normalizeResolutionFavorites(DEVICE_PRESETS.flatMap((preset) => [preset.id, preset.id])),
    ).toHaveLength(DEVICE_PRESETS.length);
  });

  it("toggles only catalogue entries and does not mutate stored input", () => {
    const input = Object.freeze(["retired", "desktop-chrome", "desktop-chrome"]);
    expect(toggleResolutionFavorite(input, "pixel-7")).toEqual(["desktop-chrome", "pixel-7"]);
    expect(toggleResolutionFavorite(input, "desktop-chrome")).toEqual([]);
    expect(toggleResolutionFavorite(input, "unknown")).toEqual(["desktop-chrome"]);
    expect(input).toEqual(["retired", "desktop-chrome", "desktop-chrome"]);
  });

  it("defaults host favorites and quality but allows retired IDs to remain readable", () => {
    expect(browserDisplayPreferences.scope).toBe("host");
    expect(browserDisplayPreferencesSchema.parse({})).toEqual({
      favoritePresetIds: [],
      captureQuality: "medium",
    });
    expect(
      browserDisplayPreferencesSchema.parse({ favoritePresetIds: ["retired"] }).favoritePresetIds,
    ).toEqual(["retired"]);
    expect(browserDisplayPreferencesSchema.safeParse({ captureQuality: "ultra" }).success).toBe(
      false,
    );
    expect(
      browserDisplayPreferencesSchema.safeParse({
        favoritePresetIds: Array(DEVICE_PRESETS.length + 1).fill("pixel-7"),
      }).success,
    ).toBe(false);
    expect(
      browserDisplayPreferencesSchema.safeParse({
        favoritePresetIds: ["x".repeat(129)],
      }).success,
    ).toBe(false);
  });
});
