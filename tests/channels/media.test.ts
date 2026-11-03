import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  INBOUND_IMAGE_LIMITS,
  MAX_INBOUND_PIXELS,
  imageSize,
  prepareInboundImage,
  sniffImageType,
} from "../../src/channels/media";

/** 真实的 8×8 纯色 PNG：Photon 能解码，且符合额度会被原样返回。 */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YWODFTEMLQkAZZlQAS/gME0AAAAASUVORK5CYII=";

function bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}


function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A real, decodable RGB PNG of any size; `pixel` decides the content. */
function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  let at = 0;
  for (let y = 0; y < height; y++) {
    raw[at++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[at++] = r;
      raw[at++] = g;
      raw[at++] = b;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("sniffImageType", () => {
  it("reads the four inline formats", () => {
    expect(sniffImageType(bytes(PNG_B64))).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
    expect(sniffImageType(new TextEncoder().encode("GIF89a......"))).toBe(
      "image/gif",
    );
    expect(sniffImageType(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe(
      "image/webp",
    );
  });

  it("rejects anything else", () => {
    expect(
      sniffImageType(new TextEncoder().encode("<html>not found")),
    ).toBeUndefined();
    expect(sniffImageType(new Uint8Array())).toBeUndefined();
  });
});

describe("prepareInboundImage", () => {
  it("passes an image within the quota through unchanged", async () => {
    await expect(prepareInboundImage(bytes(PNG_B64))).resolves.toEqual({
      mimeType: "image/png",
      data: PNG_B64,
    });
  });

  it("downscales an image over the pixel quota", async () => {
    const prepared = await prepareInboundImage(bytes(PNG_B64), {
      ...INBOUND_IMAGE_LIMITS,
      maxWidth: 4,
      maxHeight: 4,
    });

    expect(prepared?.mimeType).toBe("image/png");
    expect(prepared?.data).not.toBe(PNG_B64);
  });

  it("returns undefined for bytes that only look like an image", async () => {
    const broken = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0,
    ]);

    expect(await prepareInboundImage(broken)).toBeUndefined();
  });
});

describe("imageSize", () => {
  it("reads PNG and GIF headers", () => {
    expect(imageSize(makePng(5000, 4000, () => [1, 2, 3]), "image/png")).toEqual({
      width: 5000,
      height: 4000,
    });
    const gif = new Uint8Array(13);
    gif.set(new TextEncoder().encode("GIF89a"));
    new DataView(gif.buffer).setUint16(6, 320, true);
    new DataView(gif.buffer).setUint16(8, 200, true);
    expect(imageSize(gif, "image/gif")).toEqual({ width: 320, height: 200 });
  });

  it("reads a JPEG SOF segment", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x0f, 0xa0, 0x14, 0x00, 0x03, // SOF0: 4000x5120
      0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);

    expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 5120, height: 4000 });
  });

  it("reads a WebP VP8X canvas", () => {
    const webp = new Uint8Array(30);
    webp.set(new TextEncoder().encode("RIFF"), 0);
    webp.set(new TextEncoder().encode("WEBPVP8X"), 8);
    webp.set([9, 0, 0], 24);
    webp.set([3, 0, 0], 27);

    expect(imageSize(webp, "image/webp")).toEqual({ width: 10, height: 4 });
  });

  it("gives up on headers it cannot read", () => {
    expect(imageSize(new Uint8Array([0x89, 0x50]), "image/png")).toBeUndefined();
    expect(imageSize(new Uint8Array(40), "image/jpeg")).toBeUndefined();
    expect(imageSize(new Uint8Array(40), "image/gif")).toBeUndefined();
    expect(imageSize(new Uint8Array(40), "image/webp")).toBeUndefined();
  });
});

describe("the inbound image quota", () => {
  it("rejects an image over the pixel cap before decoding it", async () => {
    const png = makePng(8, 8, () => [1, 2, 3]);

    expect(await prepareInboundImage(png, INBOUND_IMAGE_LIMITS, 16)).toBeUndefined();
    expect(await prepareInboundImage(png, INBOUND_IMAGE_LIMITS, MAX_INBOUND_PIXELS)).toBeDefined();
  });

  it("shrinks an image until its base64 fits the byte budget", async () => {
    const png = makePng(32, 32, (x, y) => [
      (x * 97 + y * 31) % 256,
      (x * 13 + y * 197) % 256,
      (x * 61 + y * 7) % 256,
    ]);
    const budget = 500;

    const prepared = await prepareInboundImage(png, {
      ...INBOUND_IMAGE_LIMITS,
      maxBytes: budget,
    });

    expect(prepared).toBeDefined();
    expect(prepared!.data.length).toBeLessThanOrEqual(budget);
  });

  it("keeps the numbers the ChannelDO → ButlerDO budget depends on", () => {
    expect(INBOUND_IMAGE_LIMITS).toEqual({
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 500 * 1024,
    });
    expect(MAX_INBOUND_PIXELS).toBe(16_000_000);
  });
});
