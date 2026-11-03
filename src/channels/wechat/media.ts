import { createDecipheriv } from "node:crypto";

/** The CDN that fronts iLink media. */
export const WECHAT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** Where one inbound image lives, as `image_item` reports it. */
export type WeChatImageRef = {
  encryptQueryParam: string;
  /** `image_item.aeskey`: 32 hex characters. */
  aesKeyHex?: string;
  /** `image_item.media.aes_key`: base64 of either the hex string or the 16 raw bytes. */
  mediaAesKey?: string;
};

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
export function decodeAesKey(image: WeChatImageRef): Uint8Array | undefined {
  const fromHex = image.aesKeyHex ? hexToKey(image.aesKeyHex) : undefined;
  if (fromHex) return fromHex;
  if (!image.mediaAesKey) return undefined;

  const raw = base64ToBytes(image.mediaAesKey);
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
 * Downloads one inbound image, decrypting it when the payload carries a key.
 * Without a usable key the CDN object is taken as it comes: iLink does not
 * always send `aeskey`, and the reference clients download those in the clear.
 */
export async function downloadWeChatImage(
  fetchImpl: typeof fetch,
  cdnBaseUrl: string,
  image: WeChatImageRef,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const key = decodeAesKey(image);

  try {
    const response = await fetchImpl(
      `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(image.encryptQueryParam)}`,
      signal ? { signal } : {},
    );
    if (!response.ok) return undefined;
    const body = new Uint8Array(await response.arrayBuffer());
    return key ? decryptImage(body, key) : body;
  } catch {
    return undefined;
  }
}
