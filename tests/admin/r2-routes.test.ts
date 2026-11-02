import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAdminGateway,
  type AdminDeps,
} from "../../src/admin/admin-gateway";
import { createR2Routes } from "../../src/admin/r2-routes";

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
    artifacts: env.ARTIFACTS,
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
  } = {},
): Request {
  const headers = new Headers({
    authorization: `Bearer ${TOKEN}`,
    "x-backup-op": OP,
  });
  if (init.contentType !== undefined) {
    headers.set("content-type", init.contentType);
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
      }),
    );

    expect(response.status).toBe(204);
    const stored = await env.ARTIFACTS.get("upload/image.png");
    expect(stored).not.toBeNull();
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
    expect(await stored!.bytes()).toEqual(body);
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
