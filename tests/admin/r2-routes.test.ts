import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAdminGateway,
  type AdminDeps,
} from "../../src/admin/admin-gateway";
import {
  createR2Routes,
  MAX_R2_OBJECT_BYTES,
} from "../../src/admin/r2-routes";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "test-admin-token";
const OP = "op-r2";

function deps(name: string): AdminDeps {
  return {
    token: TOKEN,
    versionId: "version-test",
    butler: () => env.BUTLER.get(env.BUTLER.idFromName(name)),
    channel: () =>
      env.CHANNELS.get(env.CHANNELS.idFromName(`${name}-channels`)),
    task: (id) => env.TASK.get(env.TASK.idFromName(id)),
    bot: (id) => env.BOT.get(env.BOT.idFromName(id)),
    life: () => env.LIFE.get(env.LIFE.idFromName(`${name}-life`)),
    artifacts: env.ARTIFACTS,
    mcpAuth: () => env.MCP_AUTH.get(env.MCP_AUTH.idFromName("global")),
  };
}

function gateway(name: string) {
  return createAdminGateway(deps(name));
}

function adminRequest(
  path: string,
  init: {
    method?: string;
    body?: BodyInit;
    contentType?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    authorization: `Bearer ${TOKEN}`,
    "x-backup-op": OP,
  });
  if (init.contentType !== undefined) {
    headers.set("content-type", init.contentType);
  }
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    headers.set(name, value);
  }
  return new Request(`https://example.com${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

async function acquire(name: string): Promise<void> {
  const response = await gateway(name).fetch(
    new Request("https://example.com/admin/maintenance/acquire", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ op: "export", opId: OP }),
    }),
  );
  expect(response.status).toBe(200);
}

type ListedObject = {
  key: string;
  size: number;
  contentType: string;
};

type ListResponse = {
  objects: ListedObject[];
  next: string | null;
};

function query(key: string): string {
  return new URLSearchParams({ key }).toString();
}

async function listAll(
  routes: ReturnType<typeof createR2Routes>,
): Promise<ListedObject[]> {
  const objects: ListedObject[] = [];
  let cursor: string | null = null;
  do {
    const path =
      cursor === null
        ? "https://example.com/admin/r2/list"
        : `https://example.com/admin/r2/list?cursor=${encodeURIComponent(cursor)}`;
    const response = await routes.fetch(new Request(path));
    expect(response.status).toBe(200);
    const page = (await response.json()) as ListResponse;
    objects.push(...page.objects);
    cursor = page.next;
  } while (cursor !== null);
  return objects;
}

describe("/admin/r2/*", () => {
  it("lists objects with size and content type across pages", async () => {
    const bucket = env.ARTIFACTS;
    const existing = await bucket.list();
    await bucket.delete(existing.objects.map((object) => object.key));

    const objects = [
      ["r2-list/a.png", "png!", "image/png"],
      ["r2-list/b.txt", "text", "text/plain"],
      ["r2-list/c.json", "{}", "application/json"],
    ] as const;
    for (const [key, body, contentType] of objects) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    }

    const routes = createR2Routes(bucket, 2);

    const first = await routes.fetch(
      new Request("https://example.com/admin/r2/list"),
    );
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as ListResponse;
    expect(firstPage.objects).toHaveLength(2);
    expect(typeof firstPage.next).toBe("string");

    const second = await routes.fetch(
      new Request(
        `https://example.com/admin/r2/list?cursor=${encodeURIComponent(firstPage.next!)}`,
      ),
    );
    expect(second.status).toBe(200);
    const secondPage = (await second.json()) as ListResponse;
    expect(secondPage.next).toBeNull();

    const listed = [...firstPage.objects, ...secondPage.objects];
    expect(listed.map((object) => object.key)).toEqual([
      "r2-list/a.png",
      "r2-list/b.txt",
      "r2-list/c.json",
    ]);
    expect(listed[0]).toEqual({
      key: "r2-list/a.png",
      size: 4,
      contentType: "image/png",
    });
  });

  it("leaves inbox and work objects out of the backup listing", async () => {
    await env.ARTIFACTS.put("t1/id/keep.md", "x");
    await env.ARTIFACTS.put("inbox/tg:1/skip.pdf", "x");
    await env.ARTIFACTS.put("work/t1/skip.md", "x");

    const keys = (await listAll(createR2Routes(env.ARTIFACTS))).map(
      (object) => object.key,
    );

    expect(keys).toContain("t1/id/keep.md");
    expect(
      keys.some((key) => key.startsWith("inbox/") || key.startsWith("work/")),
    ).toBe(false);
  });

  it("includes shared skills and can delete their entries", async () => {
    await env.ARTIFACTS.put("skills/demo/SKILL.md", "# skill", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    const routes = createR2Routes(env.ARTIFACTS);
    const key = "skills/demo/SKILL.md";

    const keys = (await listAll(routes)).map((object) => object.key);
    expect(keys).toContain(key);

    const read = await routes.fetch(
      new Request(`https://example.com/admin/r2/object?${query(key)}`),
    );
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("# skill");

    const removed = await routes.fetch(
      new Request(`https://example.com/admin/r2/object?${query(key)}`, {
        method: "DELETE",
      }),
    );
    expect(removed.status).toBe(204);
    expect(await env.ARTIFACTS.head(key)).toBeNull();
  });

  it("streams an object with its content type", async () => {
    await env.ARTIFACTS.put("stream/notes.txt", "hello R2", {
      httpMetadata: { contentType: "text/plain" },
    });
    const name = "r2-stream";
    await acquire(name);

    const response = await gateway(name).fetch(
      adminRequest(`/admin/r2/object?${query("stream/notes.txt")}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-length")).toBe("8");
    expect(response.headers.get("etag")).toBe(
      (await env.ARTIFACTS.head("stream/notes.txt"))!.httpEtag,
    );
    expect(await response.text()).toBe("hello R2");

    const missing = await gateway(name).fetch(
      adminRequest(`/admin/r2/object?${query("stream/missing.png")}`),
    );
    expect(missing.status).toBe(404);
  });

  it("stores an uploaded object with its content type", async () => {
    const name = "r2-put";
    await acquire(name);
    const body = new Uint8Array([0, 1, 2, 255]);

    const response = await gateway(name).fetch(
      adminRequest(`/admin/r2/object?${query("upload/image.png")}`, {
        method: "PUT",
        body,
        contentType: "image/png",
        headers: { "content-length": String(body.byteLength) },
      }),
    );

    expect(response.status).toBe(204);
    const stored = await env.ARTIFACTS.get("upload/image.png");
    expect(stored).not.toBeNull();
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
    expect(await stored!.bytes()).toEqual(body);
  });

  it("rejects an upload larger than the object limit", async () => {
    const routes = createR2Routes(env.ARTIFACTS);
    const key = "oversized/rejected.png";

    const response = await routes.fetch(
      new Request(`https://example.com/admin/r2/object?${query(key)}`, {
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "content-length": String(MAX_R2_OBJECT_BYTES + 1),
        },
        body: new Uint8Array([1]),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: "BACKUP_OBJECT_TOO_LARGE",
    });
    expect(await env.ARTIFACTS.get(key)).toBeNull();
  });

  it("requires content-length for uploads", async () => {
    const routes = createR2Routes(env.ARTIFACTS);
    const key = "unframed/upload.png";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    const response = await routes.fetch(
      new Request(`https://example.com/admin/r2/object?${query(key)}`, {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(411);
    expect(await response.json()).toEqual({
      code: "BACKUP_INVALID",
      message: "content-length required",
    });
    expect(await env.ARTIFACTS.get(key)).toBeNull();
  });

  it("rejects an empty key", async () => {
    const name = "r2-empty-key";
    await acquire(name);

    const response = await gateway(name).fetch(
      adminRequest(`/admin/r2/object?key=`),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "BACKUP_INVALID" });
  });

  it("handles keys containing slashes, spaces and question marks", async () => {
    const name = "r2-special-key";
    await acquire(name);
    const key = "a/b c?.png";
    const body = new Uint8Array([9, 8, 7]);

    const stored = await gateway(name).fetch(
      adminRequest(`/admin/r2/object?${query(key)}`, {
        method: "PUT",
        body,
        contentType: "image/png",
        headers: { "content-length": String(body.byteLength) },
      }),
    );
    expect(stored.status).toBe(204);

    const fetched = await gateway(name).fetch(
      adminRequest(`/admin/r2/object?${query(key)}`),
    );
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(body);
  });

  it("deletes an object", async () => {
    await env.ARTIFACTS.put("delete/me.txt", "bye");
    const name = "r2-delete";
    await acquire(name);

    const response = await gateway(name).fetch(
      adminRequest(`/admin/r2/object?${query("delete/me.txt")}`, {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(204);
    expect(await env.ARTIFACTS.get("delete/me.txt")).toBeNull();
  });

  it("requires a live lease", async () => {
    const name = "r2-no-lease";

    const denied = await gateway(name).fetch(
      adminRequest("/admin/r2/list"),
    );

    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ code: "MAINTENANCE_REQUIRED" });

    await acquire(name);
    const allowed = await gateway(name).fetch(
      adminRequest("/admin/r2/list"),
    );
    expect(allowed.status).toBe(200);
  });
});
