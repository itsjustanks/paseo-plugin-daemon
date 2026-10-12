/**
 * Stable local scroll container for browser frames and their input overlay.
 * Wrappers and children never change identity when Fit/Actual changes, preserving
 * decoded frame slots and refs. Only Actual enables local scrolling. The parent
 * cancels active remote input before changing geometry and owns overlay authority.
 */
import { type ReactNode, type Ref, useLayoutEffect, useRef } from "react";
import {
  type LayoutChangeEvent,
  Platform,
  ScrollView,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import type { FrameSize } from "../../shared/managed-browser/browser";
import type { BrowserCanvasDisplayMode } from "./browser-canvas-layout";
import { configureBrowserCanvasWebScrolling } from "./browser-canvas-viewport-web";

export interface BrowserCanvasViewportProps {
  children: ReactNode;
  /** Frame wrapper from getBrowserCanvasLayout, measured in local logical pixels. */
  contentSize: FrameSize;
  mode?: BrowserCanvasDisplayMode;
  /** Desktop permits local scrollbars; native observation permits pan, remote control does not. */
  localPanEnabled: boolean;
  onLayout(event: LayoutChangeEvent): void;
  style?: StyleProp<ViewStyle>;
  viewportRef?: Ref<View>;
  contentRef?: Ref<View>;
}

const styles = StyleSheet.create({
  viewport: { flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" },
  scroll: { flex: 1 },
  horizontalContent: { height: "100%" },
  vertical: { height: "100%" },
  content: { position: "relative" },
});

/** Keep the frame coordinate origin inside the scrolling content, rather than the clipped viewport. */
export function BrowserCanvasViewport({
  children,
  contentSize,
  mode = "fit",
  localPanEnabled,
  onLayout,
  style,
  viewportRef,
  contentRef,
}: BrowserCanvasViewportProps) {
  const horizontalRef = useRef<ScrollView>(null);
  const verticalRef = useRef<ScrollView>(null);
  const actual = mode === "actual";
  const scrollEnabled = actual && localPanEnabled;
  const web = Platform.OS === "web";
  // Center a fitting Actual frame in the scrollport, not a spacer sized from
  // the outer pane. A scrollbar on one axis must not create overflow on the
  // other. Minimums keep overflowing frames reachable from origin zero.
  const actualContent = {
    flexGrow: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  useLayoutEffect(() => {
    if (web) {
      configureBrowserCanvasWebScrolling(horizontalRef.current, mode, localPanEnabled);
      return;
    }
    if (actual) return;
    // Reset local offsets without remounting either frame-buffer layer. A hidden
    // Actual offset must not shift Fit's overlay away from its displayed pixels.
    horizontalRef.current?.scrollTo({ x: 0, y: 0, animated: false });
    verticalRef.current?.scrollTo({ x: 0, y: 0, animated: false });
  }, [actual, mode, localPanEnabled, web, contentSize.width, contentSize.height]);

  const content = (
    <View ref={contentRef} style={[styles.content, contentSize]}>
      {children}
    </View>
  );

  if (web) {
    return (
      <View ref={viewportRef} style={[styles.viewport, style]} onLayout={onLayout}>
        <ScrollView
          ref={horizontalRef}
          style={styles.scroll}
          contentContainerStyle={
            actual
              ? [
                  actualContent,
                  {
                    minWidth: contentSize.width,
                    minHeight: contentSize.height,
                  },
                ]
              : contentSize
          }
          scrollEnabled={scrollEnabled}
          showsHorizontalScrollIndicator={scrollEnabled}
          showsVerticalScrollIndicator={scrollEnabled}
          keyboardShouldPersistTaps="always"
          removeClippedSubviews={false}
        >
          {content}
        </ScrollView>
      </View>
    );
  }

  return (
    <View ref={viewportRef} style={[styles.viewport, style]} onLayout={onLayout}>
      <ScrollView
        ref={horizontalRef}
        horizontal
        style={styles.scroll}
        contentContainerStyle={
          actual
            ? [styles.horizontalContent, actualContent, { minWidth: contentSize.width }]
            : [styles.horizontalContent, { width: contentSize.width }]
        }
        scrollEnabled={scrollEnabled}
        showsHorizontalScrollIndicator={scrollEnabled}
        nestedScrollEnabled
        directionalLockEnabled={false}
        keyboardShouldPersistTaps="always"
        removeClippedSubviews={false}
      >
        <ScrollView
          ref={verticalRef}
          style={[styles.vertical, { width: contentSize.width }]}
          contentContainerStyle={
            actual
              ? [actualContent, { minHeight: contentSize.height }]
              : { height: contentSize.height }
          }
          scrollEnabled={scrollEnabled}
          showsVerticalScrollIndicator={scrollEnabled}
          nestedScrollEnabled
          directionalLockEnabled={false}
          keyboardShouldPersistTaps="always"
          removeClippedSubviews={false}
        >
          {content}
        </ScrollView>
      </ScrollView>
    </View>
  );
}
