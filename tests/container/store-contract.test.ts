import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  doArtifactStore,
  type ArtifactStore,
} from "../../src/artifact-store";
import { STORE_MAX_BYTES } from "../../container/store/store-do";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const stores: [string, () => ArtifactStore][] = [
  ["r2", () => env.ARTIFACTS],
  [
    "store-do",
    () =>
      doArtifactStore(
        env.STORE_TEST.get(env.STORE_TEST.idFromName(crypto.randomUUID())),
      ),
  ],
];

function prefix(): string {
  return `${crypto.randomUUID()}/`;
}

function patternBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = index % 251;
  return bytes;
}

function bytesOf(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

describe.each(stores)("%s", (_name, store) => {
  it("returns null for a missing key", async () => {
    const key = `${prefix()}missing`;
    expect(await store().head(key)).toBeNull();
    expect(await store().get(key)).toBeNull();
  });

  it("round-trips bytes and content type", async () => {
    const key = `${prefix()}typed`;
    const bucket = store();
    await bucket.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "text/plain" },
    });

    const object = await bucket.get(key);
    expect(object).not.toBeNull();
    expect(bytesOf(await object!.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(object!.size).toBe(3);
    expect(object!.httpMetadata?.contentType).toBe("text/plain");
    expect(object!.uploaded).toBeInstanceOf(Date);
    expect(Date.now() - object!.uploaded.getTime()).toBeLessThanOrEqual(60_000);
    expect(object!.uploaded.getTime()).toBeLessThanOrEqual(Date.now());
    expect(object!.httpEtag.length).toBeGreaterThan(0);
  });

  it("accepts string, ArrayBuffer and stream values", async () => {
    const base = prefix();
    const bucket = store();
    const encoded = new TextEncoder().encode("hello");
    await bucket.put(`${base}string`, "hello");
    await bucket.put(`${base}arraybuffer`, encoded.buffer as ArrayBuffer);
    await bucket.put(`${base}stream`, new Response("hello").body!);

    for (const name of ["string", "arraybuffer", "stream"]) {
      const object = await bucket.get(`${base}${name}`);
      expect(await object!.text()).toBe("hello");
    }
  });

  it("reads an empty object", async () => {
    const key = `${prefix()}empty`;
    const bucket = store();
    await bucket.put(key, new Uint8Array(0));

    const object = await bucket.get(key);
    expect(object).not.toBeNull();
    expect(object!.size).toBe(0);
    expect(bytesOf(await object!.arrayBuffer()).length).toBe(0);
  });

  it("range: inside one chunk", async () => {
    const key = `${prefix()}range-inside`;
    const bucket = store();
    const bytes = patternBytes(3 * 1024 * 1024);
    await bucket.put(key, bytes);

    const object = await bucket.get(key, { range: { offset: 10, length: 5 } });
    expect(bytesOf(await object!.arrayBuffer())).toEqual(bytes.slice(10, 15));
  });

  it("range: across a chunk boundary", async () => {
    const key = `${prefix()}range-boundary`;
    const bucket = store();
    const bytes = patternBytes(3 * 1024 * 1024);
    await bucket.put(key, bytes);

    const object = await bucket.get(key, {
      range: { offset: 1048570, length: 12 },
    });
    expect(bytesOf(await object!.arrayBuffer())).toEqual(
      bytes.slice(1048570, 1048582),
    );
  });

  it("range: clipped at the end", async () => {
    const key = `${prefix()}range-clipped`;
    const bucket = store();
    const bytes = patternBytes(3 * 1024 * 1024);
    await bucket.put(key, bytes);

    const object = await bucket.get(key, {
      range: { offset: bytes.length - 4, length: 100 },
    });
    expect(bytesOf(await object!.arrayBuffer())).toEqual(
      bytes.slice(bytes.length - 4),
    );
  });

  it("overwrite: smaller object leaves no stale bytes", async () => {
    const key = `${prefix()}overwrite`;
    const bucket = store();
    await bucket.put(key, patternBytes(3 * 1024 * 1024));
    await bucket.put(key, patternBytes(10));

    const object = await bucket.get(key);
    expect(object!.size).toBe(10);
    expect(bytesOf(await object!.arrayBuffer())).toEqual(patternBytes(10));
  });

  it("delete: single and batch", async () => {
    const base = prefix();
    const bucket = store();
    await bucket.put(`${base}a`, "a");
    await bucket.put(`${base}b`, "b");
    await bucket.put(`${base}c`, "c");

    await bucket.delete(`${base}a`);
    expect(await bucket.head(`${base}a`)).toBeNull();

    await bucket.delete([`${base}b`, `${base}c`]);
    expect(await bucket.head(`${base}b`)).toBeNull();
    expect(await bucket.head(`${base}c`)).toBeNull();

    await bucket.delete(`${base}missing`);
  });

  it("list: prefix and pagination", async () => {
    const base = prefix();
    const bucket = store();
    const written = Array.from({ length: 5 }, (_, index) => `${base}p/${index}`);
    for (const key of written) await bucket.put(key, "x");
    await bucket.put(`${base}q/0`, "x");

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await bucket.list({ prefix: `${base}p/`, cursor, limit: 2 });
      seen.push(...page.objects.map((object) => object.key));
      if (!page.truncated) break;
      cursor = page.cursor;
    }

    expect(seen).toEqual([...written].sort());
    expect(new Set(seen).size).toBe(5);
  });

  it("list: treats prefix literally", async () => {
    const base = prefix();
    const bucket = store();
    await bucket.put(`${base}a_1`, "x");
    await bucket.put(`${base}ab1`, "x");
    await bucket.put(`${base}a%1`, "x");
    await bucket.put(`${base}axx1`, "x");

    const underscore = await bucket.list({ prefix: `${base}a_` });
    expect(underscore.objects.map((object) => object.key)).toEqual([
      `${base}a_1`,
    ]);

    const percent = await bucket.list({ prefix: `${base}a%` });
    expect(percent.objects.map((object) => object.key)).toEqual([
      `${base}a%1`,
    ]);
  });
});

describe("store-do limits", () => {
  function store(): ArtifactStore {
    return doArtifactStore(
      env.STORE_TEST.get(env.STORE_TEST.idFromName(crypto.randomUUID())),
    );
  }

  it("stores an object of exactly STORE_MAX_BYTES", async () => {
    const key = `${prefix()}max`;
    const bucket = store();
    const bytes = new Uint8Array(STORE_MAX_BYTES);
    bytes[0] = 1;
    bytes[bytes.length - 1] = 2;

    await bucket.put(key, bytes);

    const object = await bucket.get(key);
    expect(object).not.toBeNull();
    expect(object!.size).toBe(STORE_MAX_BYTES);
    const read = bytesOf(await object!.arrayBuffer());
    expect(read.length).toBe(STORE_MAX_BYTES);
    expect(read[0]).toBe(1);
    expect(read[read.length - 1]).toBe(2);
  });

  it("overwrite: an oversize put leaves the old object intact", async () => {
    const key = `${prefix()}oversize`;
    const bucket = store();
    const original = patternBytes(10);
    await bucket.put(key, original);

    await expect(
      bucket.put(key, new Uint8Array(STORE_MAX_BYTES + 1)),
    ).rejects.toThrow();

    const object = await bucket.get(key);
    expect(object!.size).toBe(10);
    expect(bytesOf(await object!.arrayBuffer())).toEqual(original);
  });
});
