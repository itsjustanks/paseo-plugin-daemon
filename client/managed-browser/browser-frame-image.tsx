/**
 * Owns one visual JPEG/decode slot. Input authority belongs to the frame-buffer
 * hook, not this image. Metadata-only captures and mouse state must not rerender
 * the native image or recreate its load callbacks when its pixels are unchanged.
 */
import { memo, useCallback, useMemo } from "react";
import { Image, StyleSheet } from "react-native";
import { createBrowserImageLoadHandler } from "./browser-image-load";

interface BrowserFrameImageProps {
  ticket: number;
  source: { uri: string };
  visible: boolean;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  cornerRadius: number;
  settled(ticket: number, succeeded: boolean): boolean;
  retry(): void;
}

const styles = StyleSheet.create({ frame: { position: "absolute" } });

/** Memoize visual values only; newer input frame IDs still commit through the parent hook. */
export const BrowserFrameImage = memo(function BrowserFrameImage(props: BrowserFrameImageProps) {
  const { ticket, source, settled, retry } = props;
  const onLoad = useMemo(
    () => createBrowserImageLoadHandler(ticket, source.uri, settled),
    [ticket, source.uri, settled],
  );
  const onError = useCallback(() => {
    if (settled(ticket, false)) {
      retry();
    }
  }, [ticket, settled, retry]);

  return (
    <Image
      accessible={props.visible}
      accessibilityLabel={props.label}
      accessibilityRole="image"
      fadeDuration={0}
      onLoad={onLoad}
      onError={onError}
      resizeMode="contain"
      source={source}
      style={[
        styles.frame,
        {
          left: props.x,
          top: props.y,
          width: props.width,
          height: props.height,
          borderRadius: props.cornerRadius,
          opacity: props.visible ? 1 : 0,
        },
      ]}
    />
  );
});
