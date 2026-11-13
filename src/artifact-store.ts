import type {
  StoreDO,
  StoredMeta,
} from "../container/store/store-do";

/**
 * The artifact store the bot reads and writes. It is a structural subset of
 * `R2Bucket`, so a Cloudflare deployment can hand the bucket over unchanged.
 */

export interface ArtifactMeta {
  key: string;
  size: number;
  uploaded: Date;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
}

export interface ArtifactBody extends ArtifactMeta {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export type ArtifactPutValue =
  | ReadableStream
  | ArrayBuffer
  | ArrayBufferView
  | string
  | null;

export interface ArtifactStore {
  head(key: string): Promise<ArtifactMeta | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<ArtifactBody | null>;
  put(
    key: string,
    value: ArtifactPutValue,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    include?: ("httpMetadata" | "customMetadata")[];
  }): Promise<{ objects: ArtifactMeta[]; truncated: boolean; cursor?: string }>;
}

/**
 * Picks the bound store. Cloudflare deployments bind R2; container
 * deployments bind the local Durable Object store instead.
 */
export function artifactStore(
  env: Pick<Env, "ARTIFACTS" | "ARTIFACT_STORE">,
): ArtifactStore {
  if (env.ARTIFACT_STORE) {
    return doArtifactStore(
      env.ARTIFACT_STORE.get(env.ARTIFACT_STORE.idFromName("global")),
    );
  }
  if (!env.ARTIFACTS) {
    throw new Error("neither ARTIFACTS nor ARTIFACT_STORE is bound");
  }
  return env.ARTIFACTS;
}

function toMeta(meta: StoredMeta): ArtifactMeta {
  return {
    key: meta.key,
    size: meta.size,
    uploaded: new Date(meta.uploadedMs),
    httpEtag: `"${meta.uploadedMs}-${meta.size}"`,
    ...(meta.contentType === null
      ? {}
      : { httpMetadata: { contentType: meta.contentType } }),
  };
}

async function bytesFrom(value: ArtifactPutValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array(0);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}

/** Adapts the container's `StoreDO` RPC surface to `ArtifactStore`. */
export function doArtifactStore(
  stub: DurableObjectStub<StoreDO>,
): ArtifactStore {
  return {
    async head(key) {
      const meta = await stub.head(key);
      return meta === null ? null : toMeta(meta);
    },

    async get(key, options) {
      const stored = await stub.get(key, options?.range);
      if (stored === null) return null;
      const bytes = stored.bytes;
      return {
        ...toMeta(stored.meta),
        body: new Response(bytes).body!,
        async arrayBuffer() {
          return bytes.slice().buffer as ArrayBuffer;
        },
        async text() {
          return new TextDecoder().decode(bytes);
        },
      };
    },

    async put(key, value, options) {
      const bytes = await bytesFrom(value);
      await stub.put(key, bytes, options?.httpMetadata?.contentType ?? null);
    },

    async delete(keys) {
      await stub.delete(typeof keys === "string" ? [keys] : keys);
    },

    async list(options) {
      const result = await stub.list({
        prefix: options?.prefix,
        cursor: options?.cursor,
        limit: options?.limit,
      });
      return {
        objects: result.objects.map(toMeta),
        truncated: result.cursor !== null,
        ...(result.cursor === null ? {} : { cursor: result.cursor }),
      };
    },
  };
}
