/** Catalogue grouping and stable-ID favorites for every resolution picker surface. */
import { DEVICE_PRESET_IDS, DEVICE_PRESETS, type DevicePresetId } from "./device-presets";

export type ResolutionPreset = (typeof DEVICE_PRESETS)[number];
export type ResolutionGroupId = "16:9" | "16:10" | "1:1" | "mobile";
export interface ResolutionGroup {
  id: ResolutionGroupId;
  label: string;
  presets: readonly ResolutionPreset[];
}

const GROUPS = [
  { id: "16:9", label: "16:9" },
  { id: "16:10", label: "16:10" },
  { id: "1:1", label: "1:1" },
  { id: "mobile", label: "Mobile" },
] as const;
const KNOWN_PRESET_IDS: ReadonlySet<string> = new Set(DEVICE_PRESET_IDS);

/** Group by actual viewport facts, keeping equal-width presets in catalogue order. */
export function groupResolutionPresets(): ResolutionGroup[] {
  const groups: ResolutionGroup[] = GROUPS.map((group) => ({
    ...group,
    presets: [],
  }));
  for (const preset of DEVICE_PRESETS) {
    const { width, height } = preset.viewport;
    let id: ResolutionGroupId;
    if (preset.isMobile) id = "mobile";
    else if (width === height) id = "1:1";
    else if (width * 9 === height * 16) id = "16:9";
    else if (width * 10 === height * 16) id = "16:10";
    else throw new Error(`Resolution preset ${preset.id} requires an aspect-ratio group`);
    const group = groups.find((candidate) => candidate.id === id);
    if (!group) throw new Error(`Resolution group ${id} is missing`);
    group.presets = [...group.presets, preset];
  }
  return groups.map((group) => ({
    ...group,
    presets: [...group.presets].sort((a, b) => a.viewport.width - b.viewport.width),
  }));
}

/** Drop removed/unknown IDs and duplicates, retaining the user's favorite order. */
export function normalizeResolutionFavorites(ids: readonly string[]): DevicePresetId[] {
  const favorites: DevicePresetId[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!KNOWN_PRESET_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    favorites.push(id as DevicePresetId);
    if (favorites.length === DEVICE_PRESETS.length) break;
  }
  return favorites;
}

/** Project stored favorites in picker order without rewriting the user's saved settings. */
export function orderedResolutionFavorites(ids: readonly string[]): DevicePresetId[] {
  const favorites = new Set(normalizeResolutionFavorites(ids));
  return groupResolutionPresets()
    .flatMap((group) => group.presets)
    .filter((preset) => favorites.has(preset.id))
    .map((preset) => preset.id);
}

/** Toggle only a current preset. Unknown IDs cannot become persisted shortcuts. */
export function toggleResolutionFavorite(ids: readonly string[], id: string): DevicePresetId[] {
  const current = normalizeResolutionFavorites(ids);
  if (!KNOWN_PRESET_IDS.has(id)) return current;
  if (current.includes(id as DevicePresetId)) return current.filter((existing) => existing !== id);
  return [...current, id as DevicePresetId];
}
