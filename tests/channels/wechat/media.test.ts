import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeAesKey,
  decryptImage,
  downloadWeChatMedia,
} from "../../../src/channels/wechat/media";

const KEY_HEX = "00112233445566778899aabbccddeeff";
/** 32 位 hex 再做 base64：`media.aes_key` 的一种历史编码。 */
const BASE64_OF_HEX = "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=";
/** 16 字节原数据再做 base64：另一种历史编码。 */
const BASE64_OF_BYTES = "ABEiM0RVZneImaq7zN3u/w==";

const PLAIN = new TextEncoder().encode("not really a png, but bytes are bytes");

function encrypt(plain: Uint8Array, keyHex = KEY_HEX): Uint8Array {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null);
  return new Uint8Array(Buffer.concat([cipher.update(plain), cipher.final()]));
}

describe("decodeAesKey", () => {
  it("reads the hex aeskey", () => {
    expect(
      Array.from(decodeAesKey({ encryptQueryParam: "p", aesKeyHex: KEY_HEX }) ?? []),
    ).toEqual(Array.from(Buffer.from(KEY_HEX, "hex")));
  });

  it("reads media.aes_key as base64 of the hex string", () => {
    expect(
      Array.from(
        decodeAesKey({ encryptQueryParam: "p", mediaAesKey: BASE64_OF_HEX }) ?? [],
      ),
    ).toEqual(Array.from(Buffer.from(KEY_HEX, "hex")));
  });

  it("reads media.aes_key as base64 of the 16 raw bytes", () => {
    expect(
      Array.from(
        decodeAesKey({ encryptQueryParam: "p", mediaAesKey: BASE64_OF_BYTES }) ?? [],
      ),
    ).toEqual(Array.from(Buffer.from(KEY_HEX, "hex")));
  });

  it("ignores a key it cannot decode", () => {
    expect(decodeAesKey({ encryptQueryParam: "p" })).toBeUndefined();
    expect(
      decodeAesKey({ encryptQueryParam: "p", mediaAesKey: "AAAA" }),
    ).toBeUndefined();
    expect(decodeAesKey({ encryptQueryParam: "p", aesKeyHex: "zz" })).toBeUndefined();
  });
});

describe("decryptImage", () => {
  it("round-trips an ECB ciphertext", () => {
    const key = Buffer.from(KEY_HEX, "hex");

    expect(Array.from(decryptImage(encrypt(PLAIN), key) ?? [])).toEqual(
      Array.from(PLAIN),
    );
  });

  it("rejects a ciphertext that is not whole blocks", () => {
    const key = Buffer.from(KEY_HEX, "hex");

    expect(decryptImage(encrypt(PLAIN).subarray(0, 17), key)).toBeUndefined();
    expect(decryptImage(new Uint8Array(), key)).toBeUndefined();
  });

  it("rejects a wrong key instead of returning garbage", () => {
    const wrong = Buffer.from("ffffffffffffffffffffffffffffffff", "hex");
    const plain = new Uint8Array(32).fill(7);

    expect(decryptImage(encrypt(plain), wrong)).toBeUndefined();
  });
});

describe("downloadWeChatMedia", () => {
  it("fetches the CDN object and decrypts it", async () => {
    const calls: string[] = [];
    const ciphertext = encrypt(PLAIN);
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(ciphertext, { status: 200 });
    }) as typeof fetch;

    const bytes = await downloadWeChatMedia(
      fetchImpl,
      "https://novac2c.cdn.weixin.qq.com/c2c",
      { encryptQueryParam: "p 1", aesKeyHex: KEY_HEX },
    );

    expect(Array.from(bytes ?? [])).toEqual(Array.from(PLAIN));
    expect(calls).toEqual([
      "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=p%201",
    ]);
  });

  it("downloads plaintext when the item carries no key", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(PLAIN, { status: 200 });
    }) as typeof fetch;

    const bytes = await downloadWeChatMedia(fetchImpl, "https://cdn.example.com", {
      encryptQueryParam: "p-2",
    });

    expect(Array.from(bytes ?? [])).toEqual(Array.from(PLAIN));
    expect(calls).toEqual([
      "https://cdn.example.com/download?encrypted_query_param=p-2",
    ]);
  });

  it("returns undefined when the CDN fails or the key is missing", async () => {
    const failing = (async () => new Response("nope", { status: 500 })) as typeof fetch;

    expect(
      await downloadWeChatMedia(failing, "https://cdn.example.com", {
        encryptQueryParam: "p",
        aesKeyHex: KEY_HEX,
      }),
    ).toBeUndefined();
    expect(
      await downloadWeChatMedia(failing, "https://cdn.example.com", {
        encryptQueryParam: "p",
      }),
    ).toBeUndefined();
  });
});
