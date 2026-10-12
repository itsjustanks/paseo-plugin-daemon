/**
 * Read-only cursor resolution for the guarded native page in agent-browser-runtime.
 * CSS keeps `auto` as its computed value; resolve selectable glyphs/editing surfaces
 * without exporting page text, changing selection, or inspecting a whole subtree.
 * The page program handles the top document and exposed shadow roots. Opaque
 * frames remain subject to the existing top-document hit-test limitation.
 */
const CURSOR_HIT_TEST = `(x, y) => {
  let element = document.elementFromPoint(x, y);
  if (!element) return null;

  const shadowRoots = [];
  // Bound descent and retain roots for Chromium's caret hit-test options.
  for (let depth = 0; depth < 16 && element.shadowRoot; depth++) {
    const root = element.shadowRoot;
    const inner = root.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    shadowRoots.push(root);
    element = inner;
  }

  const style = getComputedStyle(element);
  if (style.cursor !== 'auto') return style.cursor;
  if (style.userSelect === 'none') return 'default';

  const textCursor = style.writingMode.startsWith('vertical') ||
    style.writingMode.startsWith('sideways') ? 'vertical-text' : 'text';
  if (element.isContentEditable) return textCursor;

  // Explicit auto on text controls must also work over empty editable space.
  const textInputTypes = ['text', 'search', 'url', 'tel', 'email', 'password', 'number'];
  const textControl = element.tagName === 'TEXTAREA' ||
    (element.tagName === 'INPUT' && textInputTypes.includes(element.type));
  if (textControl && !element.disabled) return textCursor;

  let node;
  let offset;
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y, { shadowRoots });
    node = position?.offsetNode;
    offset = position?.offset;
  } else if (document.caretRangeFromPoint) {
    const position = document.caretRangeFromPoint(x, y);
    node = position?.startContainer;
    offset = position?.startOffset;
  }
  if (!node || node.nodeType !== 3 || !element.contains(node) ||
      !Number.isInteger(offset) || node.length === 0) return 'default';

  // Caret APIs can snap to nearby text even over padding. Check only adjacent
  // glyph rectangles so blank areas and overlays never inherit a text cursor.
  const range = document.createRange();
  range.setStart(node, Math.max(0, offset - 1));
  range.setEnd(node, Math.min(node.length, offset + 1));
  for (const rect of range.getClientRects()) {
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
      return textCursor;
    }
  }
  return 'default';
}`;

/** Build the fixed page program with numeric CSS coordinates, never executable caller input. */
export function browserCursorExpression(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new Error("Cursor coordinates must be finite non-negative CSS pixels");
  }
  return `(${CURSOR_HIT_TEST})(${x}, ${y})`;
}
