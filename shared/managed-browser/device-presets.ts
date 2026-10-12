/** Device emulation facts and display sizes shared by the picker and server policy. */
const DESKTOP_CHROME_EMULATION = {
  deviceScaleFactor: 1,
  captureScale: 1,
  isMobile: false,
  hasTouch: false,
  platform: "Win32",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Safari/537.36",
} as const;

/** Larger desktop presets change resolution while retaining the same input and browser behavior. */
function createDesktopPreset<const Id extends string>(id: Id, width: number, height: number) {
  const name = width === height ? `${width} square` : `${height}p`;

  return {
    ...DESKTOP_CHROME_EMULATION,
    id,
    label: name,
    shortLabel: name,
    viewport: { width, height },
  } as const;
}

const PIXEL_7_EMULATION = {
  id: "pixel-7",
  label: "Pixel 7",
  shortLabel: "Pixel 7",
  viewport: { width: 412, height: 839 },
  deviceScaleFactor: 2.625,
  captureScale: 1,
  isMobile: true,
  hasTouch: true,
  platform: "Linux armv81",
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Mobile Safari/537.36",
} as const;

export const DEVICE_PRESETS = [
  createDesktopPreset("desktop-chrome", 1280, 720),
  createDesktopPreset("desktop-1280x800", 1280, 800),
  createDesktopPreset("desktop-1280x1280", 1280, 1280),
  createDesktopPreset("desktop-1440x810", 1440, 810),
  createDesktopPreset("desktop-1440x900", 1440, 900),
  createDesktopPreset("desktop-1440x1440", 1440, 1440),
  createDesktopPreset("desktop-1920x1080", 1920, 1080),
  createDesktopPreset("desktop-2560x1440", 2560, 1440),
  createDesktopPreset("desktop-1920x1200", 1920, 1200),
  createDesktopPreset("desktop-2560x1600", 2560, 1600),
  createDesktopPreset("desktop-1920x1920", 1920, 1920),
  createDesktopPreset("desktop-2560x2560", 2560, 2560),
  {
    id: "iphone-15-pro",
    label: "iPhone 15 Pro",
    shortLabel: "iPhone 15",
    viewport: { width: 393, height: 659 },
    deviceScaleFactor: 3,
    captureScale: 1,
    isMobile: true,
    hasTouch: true,
    platform: "iPhone",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
  },
  PIXEL_7_EMULATION,
  {
    ...PIXEL_7_EMULATION,
    id: "pixel-7-sharp",
    label: "Pixel 7 (high resolution)",
    shortLabel: "Pixel 7 HD",
    captureScale: 2,
  },
  {
    id: "ipad-pro-11",
    label: "iPad Pro 11",
    shortLabel: "iPad 11",
    viewport: { width: 834, height: 1194 },
    deviceScaleFactor: 2,
    captureScale: 1,
    isMobile: true,
    hasTouch: true,
    platform: "iPad",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
  },
] as const;

// The schema and picker derive from one catalogue, so adding a preset cannot leave it unselectable.
export const DEVICE_PRESET_IDS = DEVICE_PRESETS.map((preset) => preset.id);
export type DevicePresetId = (typeof DEVICE_PRESET_IDS)[number];
