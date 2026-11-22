/**
 * QR codes as chat images. WeChat only opens its own real-name and bind links
 * when they are scanned, and a deployment without a public address cannot hand
 * out a page, so both codes are delivered as PNG bytes through the channel.
 *
 * The encoder is hand-rolled: `qrcode`'s browser build exposes the module
 * matrix but not a PNG path, and `pngjs` is only a transitive dependency of it.
 */
import { create as createQr } from "qrcode";

/** The symbol as a grayscale PNG, sized for a phone screen. */
export async function renderQrPng(text: string, scale = 8): Promise<Uint8Array> {
  const qr = createQr(text, { errorCorrectionLevel: "M" });
  const modules = qr.modules.size;
  // ISO/IEC 18004 wants a 4-module quiet zone; phones tolerate less, but a
  // forwarded chat image gets resized, so keep the full margin.
  const quiet = 4;
  const side = (modules + quiet * 2) * scale;

  // One filter byte per row, then one byte per pixel: 0 is black, 255 white.
  const raw = new Uint8Array((side + 1) * side).fill(0xff);
  for (let y = 0; y < side; y += 1) raw[y * (side + 1)] = 0;
  for (let y = 0; y < modules; y += 1) {
    for (let x = 0; x < modules; x += 1) {
      if (!qr.modules.get(x, y)) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        let at = (y + quiet) * scale + dy;
        let offset = at * (side + 1) + 1 + (x + quiet) * scale;
        for (let dx = 0; dx < scale; dx += 1) {
          raw[offset] = 0;
          offset += 1;
        }
      }
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, side);
  view.setUint32(4, side);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  const parts = [
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", await deflateZlib(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG wants zlib-wrapped deflate; `CompressionStream("deflate")` is exactly that. */
async function deflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  const body = new Response(bytes).body;
  if (body === null) throw new Error("png: no body");
  const stream = body.pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
