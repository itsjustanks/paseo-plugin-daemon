import { expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: (styles: unknown) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("./browser-capture-density-controls", () => ({
  BrowserCaptureDensityControls: () => null,
}));

const { DEFAULT_CAPTURE_QUALITY } = await import("../../shared/managed-browser/capture-settings");
const { jpegQualityOptions } = await import("./browser-quality-controls");

it("badges exactly the actual default JPEG quality, not a hard-coded tier", () => {
  const options = jpegQualityOptions();
  expect(options.filter((option) => "detail" in option && option.detail === "Default")).toEqual([
    expect.objectContaining({ value: DEFAULT_CAPTURE_QUALITY, label: "65%" }),
  ]);
  expect(options.find((option) => option.value === "high")).not.toHaveProperty("detail");
  expect(options.find((option) => option.value === "maximum")).toHaveProperty(
    "detail",
    "Largest JPEGs",
  );
});
