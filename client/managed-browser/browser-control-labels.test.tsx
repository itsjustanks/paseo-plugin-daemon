import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
vi.mock("react-native", () => ({ Pressable: "Pressable", Text: "Text", View: "View", ScrollView: "ScrollView",
  StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));
vi.mock("./browser-chrome", () => ({ ChromeIconButton: "ChromeIconButton" }));
import { ControlButton } from "./browser-control-button";
import { BrowserTabs } from "./browser-tabs";
import { createStyles } from "./browser-panel-styles";
const theme = { colors: { foreground: "white", foregroundMuted: "gray", accent: "blue", accentForeground: "white" } } as any;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it.each([["Control", "Take control", true], ["Return", "Return to agent", true],
  ["Take control", "Take control", false], ["Return to agent", "Return to agent", false]] as const)(
  "%s remains visible, accessible and at least44px with compact=%s", (label, accessible, compact) => {
    const press = vi.fn(); let rendered!: ReactTestRenderer;
    act(() => { rendered = create(<ControlButton styles={createStyles(theme, compact)} theme={theme}
      label={label} accessibilityLabel={accessible} large onPress={press} />); });
    const button = rendered.root.findByProps({ accessibilityRole: "button" });
    expect(button.props.accessibilityLabel).toBe(accessible);
    expect(rendered.root.findByType("Text" as any).props.children).toBe(label);
    const style = Object.assign({}, ...button.props.style({ pressed: false }).filter(Boolean));
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    act(() => button.props.onPress()); expect(press).toHaveBeenCalledOnce();
    act(() => rendered.unmount());
  });

it("selected-tab controller status stays first and viewer details remain accessible", () => {
  let rendered!: ReactTestRenderer;
  act(() => { rendered = create(<BrowserTabs styles={createStyles(theme, true)} theme={theme}
    tabs={[{ id: "tab", title: "Synthetic page", url: "about:blank", viewerCount: 12, controllerLabel: null } as any]}
    selectedId="tab" selectedState={null} statusColor="green" statusLabel="Ready" controlAction={null}
    canCreate canClose={false} onSelect={() => {}} onCreate={() => {}} onClose={() => {}} />); });
  const tab = rendered.root.findByProps({ accessibilityRole: "tab" });
  expect(tab.props.accessibilityLabel).toContain("12 viewers · No controller");
  expect(rendered.root.findAllByType("Text" as any).map(node => node.props.children)).toContain("No controller");
  act(() => rendered.unmount());
});
