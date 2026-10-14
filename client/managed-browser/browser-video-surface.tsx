/** Web renderer boundary. Other clients keep the JPEG path; the host SDK this plugin
 * is pinned to publishes no encoded-video surface. */
import { useEffect } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import * as Web from "./web";

export type BrowserVideoCanvasNode = Web.BrowserVideoCanvasNode;
export const supportsBrowserVideo = Web.supportsBrowserVideo;
export const bindBrowserVideoVisibility = Web.bindBrowserVideoVisibility;
export const createBrowserVideoEnvironment = Web.createBrowserVideoEnvironment;

interface SurfaceProps {
  canvasRef(value: unknown): void;
  style: StyleProp<ViewStyle>;
}

/** Pointer handling stays on the sibling touch overlay, never inside the canvas host. */
export function BrowserVideoSurface({ canvasRef, style }: SurfaceProps) {
  useEffect(() => () => canvasRef(null), [canvasRef]);
  return <View ref={canvasRef} style={style} pointerEvents="none" accessible={false} />;
}
