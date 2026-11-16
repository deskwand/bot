import { createDecipheriv } from "node:crypto";

/** The CDN that fronts iLink media. */
export const WECHAT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** Where one inbound CDN object lives, as `image_item`/`file_item` reports it. */
export type WeChatMediaRef = {
  encryptQueryParam: string;
  /** `image_item.aeskey`: 32 hex characters. */
  aesKeyHex?: string;
  /** `media.aes_key`: base64 of either the hex string or the 16 raw bytes. */
  mediaAesKey?: string;
};

export type WeChatImageRef = WeChatMediaRef;

function hexToKey(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return undefined;
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    key[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return key;
}

function base64ToBytes(value: string): Uint8Array | undefined {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return undefined;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The 16-byte AES key: `aeskey` first, then either encoding of `media.aes_key`. */
export function decodeAesKey(media: WeChatMediaRef): Uint8Array | undefined {
  const fromHex = media.aesKeyHex ? hexToKey(media.aesKeyHex) : undefined;
  if (fromHex) return fromHex;
  if (!media.mediaAesKey) return undefined;

  const raw = base64ToBytes(media.mediaAesKey);
  if (!raw) return undefined;
  if (raw.length === 16) return raw;
  return hexToKey(new TextDecoder().decode(raw));
}

/** PKCS7 unpad with a real check: a bad pad means the key was wrong. */
function unpad(bytes: Uint8Array): Uint8Array | undefined {
  const pad = bytes[bytes.length - 1];
  if (pad === undefined || pad < 1 || pad > 16 || pad > bytes.length) return undefined;
  for (let i = bytes.length - pad; i < bytes.length; i++) {
    if (bytes[i] !== pad) return undefined;
  }
  return bytes.subarray(0, bytes.length - pad);
}

/** AES-128-ECB decrypt of one CDN object; `undefined` when it is not plaintext. */
export function decryptImage(
  ciphertext: Uint8Array,
  key: Uint8Array,
): Uint8Array | undefined {
  if (key.length !== 16 || ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    return undefined;
  }

  try {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(false);
    return unpad(new Uint8Array(decipher.update(ciphertext)));
  } catch {
    return undefined;
  }
}

/**
 * Downloads one inbound CDN object, decrypting it when the payload carries a
 * key. Without a usable key the CDN object is taken as it comes: iLink does
 * not always send `aeskey`, and the reference clients download those in the
 * clear. Images and files share this path.
 */
export async function downloadWeChatMedia(
  fetchImpl: typeof fetch,
  cdnBaseUrl: string,
  media: WeChatMediaRef,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const key = decodeAesKey(media);
  // The URL carries a signed query parameter, so only the status, the error
  // and the byte count are logged; describeError redacts the parameter in case
  // a fetch rejection echoes it back.
  const url = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encryptQueryParam)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, signal ? { signal } : {});
  } catch (err) {
    console.warn(`channel: wechat media download failed: ${describeError(err)}`);
    return undefined;
  }
  if (!response.ok) {
    console.warn(`channel: wechat media download failed: status=${response.status}`);
    return undefined;
  }

  let body: Uint8Array;
  try {
    body = new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    console.warn(`channel: wechat media body unreadable: ${describeError(err)}`);
    return undefined;
  }
  if (!key) return body;

  const plain = decryptImage(body, key);
  if (!plain) {
    // Separate the three ways AES-128-ECB can refuse: wrong length, or a pad
    // that does not unpad (wrong key). content-type names the "200 but not an
    // image" answer the caller documents.
    const contentType = response.headers.get("content-type") ?? "?";
    console.warn(
      `channel: wechat media decrypt failed: bytes=${body.length}` +
        ` mod16=${body.length % 16} key=${media.aesKeyHex ? "hex" : "base64"}` +
        ` content-type=${contentType}`,
    );
  }
  return plain;
}

/** Bounded and redacted: a fetch rejection can quote the URL it was given. */
function describeError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text
    .replace(/encrypted_query_param=[^&\s"']*/g, "encrypted_query_param=***")
    .slice(0, 200);
}
