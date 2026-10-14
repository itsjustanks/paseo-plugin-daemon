/** Exact large-packet conversion across native byte APIs and older web clients. */
import { expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

import { decodeBrowserVideoBytes } from "./web";

/** The test runner can predate the byte API; model presence without a polyfill
 * in production and always restore its exact original property descriptor. */
function withByteDecoder(decode: ((value: string) => Uint8Array) | undefined, perform: () => void) {
  const original = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
  Object.defineProperty(Uint8Array, "fromBase64", { value: decode, configurable: true });
  try {
    perform();
  } finally {
    if (original) Object.defineProperty(Uint8Array, "fromBase64", original);
    else Reflect.deleteProperty(Uint8Array, "fromBase64");
  }
}

it("decodes large and padded packets exactly using the native byte API", () => {
  const native = vi.fn((value: string) => new Uint8Array(Buffer.from(value, "base64")));
  withByteDecoder(native, () => {
    for (const size of [0, 1, 2, 65537, 1048576]) {
      const source = Buffer.alloc(size);
      for (let i = 0; i < size; i += 1) source[i] = (i * 17 + 13) % 256;
      expect(Buffer.from(decodeBrowserVideoBytes(source.toString("base64"))).equals(source)).toBe(
        true,
      );
    }
  });
  expect(native).toHaveBeenCalledTimes(5);
});

it("decodes identical bytes without native conversion and rejects malformed payloads", () => {
  withByteDecoder(undefined, () => {
    const source = Buffer.alloc(1048577);
    for (let i = 0; i < source.length; i += 1) source[i] = (i * 17 + 13) % 256;
    expect(Buffer.from(decodeBrowserVideoBytes(source.toString("base64"))).equals(source)).toBe(
      true,
    );
    expect(() => decodeBrowserVideoBytes("%%invalid%%")).toThrow();
  });
});
