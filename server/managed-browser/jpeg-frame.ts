/** Read actual JPEG dimensions so CDP viewport metadata cannot authorize input on cropped pixels. */
export function readJpegFrameDimensions(
  dataBase64: string,
): { width: number; height: number } | null {
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return null;

    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    // All JPEG start-of-frame markers except the Huffman/arithmetic table markers.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}
