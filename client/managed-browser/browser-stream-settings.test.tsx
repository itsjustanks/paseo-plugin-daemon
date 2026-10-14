import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
vi.mock("react-native", () => ({ Pressable: "Pressable", Text: "Text", View: "View",
  StyleSheet: { create: (value: unknown) => value } }));
vi.mock("./browser-capture-density-controls", () => ({ BrowserCaptureDensityControls: () => null }));
import { BrowserQualityControls } from "./browser-quality-controls";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("renders bounded rate choices with 44px targets and changes viewing settings independently", () => {
  let tree!: ReactTestRenderer;
  const bitrate = vi.fn(), fps = vi.fn(), quality = vi.fn(), density = vi.fn();
  act(() => { tree = create(<BrowserQualityControls theme={{ colors: {} } as any} disabled={false}
    density={1} densityMode="auto" viewport={{ width: 390, height: 744 }} densityDisabled={false}
    onDensityChange={density} captureQuality="medium" videoBitrate={12_000_000} videoFps={30}
    onQualityChange={quality} onVideoBitrateChange={bitrate} onVideoFpsChange={fps} />); });
  const buttons = tree.root.findAllByProps({ accessibilityRole: "button" });
  for (const button of buttons) {
    const style = Object.assign({}, ...button.props.style({ pressed: false }).filter(Boolean));
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  }
  const rate = buttons.find(b => b.props.accessibilityLabel === "Video frame rate limit: Up to 60 FPS")!;
  act(() => rate.props.onPress()); expect(fps).toHaveBeenCalledExactlyOnceWith(60);
  const bandwidth = buttons.find(b => b.props.accessibilityLabel === "Video bitrate: 2 Mbps")!;
  act(() => bandwidth.props.onPress()); expect(bitrate).toHaveBeenCalledExactlyOnceWith(2_000_000);
  expect(quality).not.toHaveBeenCalled(); expect(density).not.toHaveBeenCalled();
  expect(buttons.some(b => String(b.props.accessibilityLabel).includes("120 FPS"))).toBe(false);
  act(() => tree.unmount());
});
