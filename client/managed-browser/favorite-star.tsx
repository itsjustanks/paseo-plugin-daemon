/** Filled and outlined favorite indicators with identical cross-platform font geometry. */
import { Text } from "react-native";

/** The host Icon API exposes stroke only; paired system glyphs provide real fill on phones too. */
export function FavoriteStar({
  filled,
  color,
  size = 18,
}: {
  filled: boolean;
  color: string;
  size?: number;
}) {
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ color, fontSize: size, lineHeight: size + 2, textAlign: "center" }}
    >
      {filled ? "\u2605" : "\u2606"}
    </Text>
  );
}
