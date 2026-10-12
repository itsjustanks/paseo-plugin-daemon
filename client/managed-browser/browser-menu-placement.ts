/** Panel-relative menu placement; the pane already excludes the host's safe areas. */
export interface MenuRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Anchor to the trigger's right edge and prefer below, with bounded internal scrolling. */
export function browserMenuPlacement(
  pane: { width: number; height: number },
  anchor: MenuRect,
  preferredHeight: number,
): MenuRect | null {
  const values = [
    pane.width,
    pane.height,
    anchor.x,
    anchor.y,
    anchor.width,
    anchor.height,
    preferredHeight,
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    pane.width <= 16 ||
    pane.height <= 16 ||
    anchor.width <= 0 ||
    anchor.height <= 0 ||
    preferredHeight <= 0
  ) {
    return null;
  }

  const margin = 8;
  const gap = 4;
  const width = Math.min(300, pane.width - margin * 2);
  const x = Math.max(
    margin,
    Math.min(pane.width - margin - width, anchor.x + anchor.width - width),
  );
  const below = Math.max(0, pane.height - margin - anchor.y - anchor.height - gap);
  const above = Math.max(0, anchor.y - margin - gap);
  const useBelow = below >= preferredHeight || below >= above;
  const height = Math.min(preferredHeight, useBelow ? below : above, pane.height - margin * 2);
  if (height < 1) return null;

  const y = useBelow ? anchor.y + anchor.height + gap : anchor.y - gap - height;
  return { x, y: Math.max(margin, Math.min(pane.height - margin - height, y)), width, height };
}

/** Place a flyout beside its parent, flip left when needed, and clamp to the pane. */
export function browserSubmenuPlacement(
  pane: { width: number; height: number },
  parent: MenuRect,
  row: MenuRect,
  preferredHeight: number,
): MenuRect | null {
  const values = [pane.width, pane.height, parent.x, parent.width, row.y, preferredHeight];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    pane.width <= 16 ||
    pane.height <= 16 ||
    preferredHeight <= 0
  ) {
    return null;
  }
  const width = Math.min(240, pane.width - 16);
  const height = Math.min(preferredHeight, pane.height - 16);
  const right = parent.x + parent.width + 4;
  const x = right + width <= pane.width - 8 ? right : parent.x - width - 4;
  return {
    x: Math.max(8, Math.min(pane.width - 8 - width, x)),
    y: Math.max(8, Math.min(pane.height - 8 - height, row.y)),
    width,
    height,
  };
}
