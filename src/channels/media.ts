import { createCloudflarePhotonImages } from "@earendil-works/pi-durable/images/cloudflare";
import type { ImageLimits, ImageProcessor } from "@earendil-works/pi-durable/tools";
import type { InboundImage } from "../protocol";

/**
 * What an inbound image must fit. `maxBytes` counts base64; 500 KiB keeps the
 * ChannelDO → ButlerDO call under its 1 MiB serialized limit and pi's
 * transcript row under SQLite's 2 MB value limit.
 */
export const INBOUND_IMAGE_LIMITS: ImageLimits = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 500 * 1024,
};

/**
 * How many pixels one inbound image may decode to. Photon decodes into RGBA in
 * wasm (4 bytes per pixel) and that heap never shrinks, so a 7000×5000 photo
 * that is under 1 MB on the wire still needs ~134 MB — past the 128 MB an
 * isolate gets. 16 MP keeps the decode under 64 MB and above any phone's
 * default output.
 */
export const MAX_INBOUND_PIXELS = 16_000_000;

let processor: ImageProcessor | undefined;

/** The formats every provider takes inline; anything else is dropped. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function readU16(bytes: Uint8Array, offset: number, bigEndian: boolean): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 2);
  return bigEndian ? view.getUint16(0) : view.getUint16(0, true);
}

function readU24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readU32(bytes: Uint8Array, offset: number, bigEndian: boolean): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return bigEndian ? view.getUint32(0) : view.getUint32(0, true);
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const length = readU16(bytes, offset + 2, true);
    if (length < 2) return undefined;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        width: readU16(bytes, offset + 7, true),
        height: readU16(bytes, offset + 5, true),
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === "VP8X") {
    return { width: readU24(bytes, 24) + 1, height: readU24(bytes, 27) + 1 };
  }
  if (chunk === "VP8 ") {
    return {
      width: readU16(bytes, 26, false) & 0x3fff,
      height: readU16(bytes, 28, false) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const bits = readU32(bytes, 21, false);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/** Intrinsic pixel size of an image, read from its header without decoding. */
export function imageSize(
  bytes: Uint8Array,
  mimeType: string,
): { width: number; height: number } | undefined {
  const size = readImageSize(bytes, mimeType);
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}

function readImageSize(
  bytes: Uint8Array,
  mimeType: string,
): { width: number; height: number } | undefined {
  switch (mimeType) {
    case "image/png":
      return bytes.length >= 24
        ? { width: readU32(bytes, 16, true), height: readU32(bytes, 20, true) }
        : undefined;
    case "image/gif":
      return bytes.length >= 10
        ? { width: readU16(bytes, 6, false), height: readU16(bytes, 8, false) }
        : undefined;
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    default:
      return undefined;
  }
}

/**
 * One line describing bytes that failed preparation: length, leading bytes and
 * the format they claim. Never the payload itself, so it stays safe to log.
 */
export function describeImageBytes(bytes: Uint8Array): string {
  const head = Array.from(bytes.subarray(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const mimeType = sniffImageType(bytes);
  const size = mimeType === undefined ? undefined : imageSize(bytes, mimeType);
  return `len=${bytes.length} head=${head} format=${mimeType ?? "unknown"}${
    size === undefined ? "" : ` size=${size.width}x${size.height}`
  }`;
}

/** Why an inbound image was dropped, and what the decoder said when it refused. */
export type InboundImageOutcome =
  | { ok: true; image: InboundImage }
  | {
      ok: false;
      /** `format` and `pixels` are judged from the bytes; `prepare` is the decoder. */
      reason: "format" | "pixels" | "prepare";
      detail?: string;
    };

/**
 * Turns inbound bytes into something the model can take: sniffed, oriented,
 * downscaled and re-encoded to fit `limits`. Never throws.
 *
 * `limits` and `maxPixels` are seams for tests; production callers never
 * pass them. The caller gets the reason a failure happened, so a log line can
 * say which stage dropped the image.
 */
export async function prepareInboundImage(
  bytes: Uint8Array,
  limits: ImageLimits = INBOUND_IMAGE_LIMITS,
  maxPixels: number = MAX_INBOUND_PIXELS,
): Promise<InboundImageOutcome> {
  const mimeType = sniffImageType(bytes);
  if (!mimeType) return { ok: false, reason: "format" };

  const size = imageSize(bytes, mimeType);
  if (!size || size.width * size.height > maxPixels) {
    return { ok: false, reason: "pixels" };
  }

  // Photon keeps one WebAssembly heap per isolate and never gives it back, so a
  // processor that failed once can fail every later image until the isolate
  // restarts. Rebuild it and try once more before calling the image unusable.
  let detail: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = (processor ??= createCloudflarePhotonImages());
    try {
      const prepared = await current.prepare(bytes, mimeType, limits);
      if (!prepared) {
        // Nothing fit the limits: a second decoder cannot change that.
        return {
          ok: false,
          reason: "prepare",
          detail: "not encodable within limits",
        };
      }
      return {
        ok: true,
        image: { mimeType: prepared.mimeType, data: prepared.data },
      };
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      processor = undefined;
    }
  }
  return { ok: false, reason: "prepare", detail };
}
