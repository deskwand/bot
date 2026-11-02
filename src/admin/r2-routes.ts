/**
 * `/admin/r2/*`: artifact object access for the desktop client's backups.
 *
 * Every route is mounted behind the admin gateway's token check and
 * maintenance lease; this module only speaks to the `ARTIFACTS` binding.
 * Object keys travel as query parameters so they never need path escaping.
 */

const LIST_PATH = "/admin/r2/list";
const OBJECT_PATH = "/admin/r2/object";

/** One Worker request body, and therefore one R2 object, is capped here. */
export const MAX_R2_OBJECT_BYTES = 100 << 20;

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorCode(code: string, status: number): Response {
  return json({ code }, status);
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function invalid(message: string): Response {
  return json({ code: "BACKUP_INVALID", message }, 400);
}

function objectKey(url: URL): string | Response {
  const key = url.searchParams.get("key");
  if (key === null) return invalid("object needs a key");
  return key;
}

export function createR2Routes(
  bucket: R2Bucket,
  listLimit = 1000,
): { fetch(req: Request): Promise<Response> } {
  async function list(url: URL): Promise<Response> {
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const result = await bucket.list({
      cursor,
      limit: listLimit,
      include: ["httpMetadata"],
    });
    return json({
      objects: result.objects.map((object) => ({
        key: object.key,
        size: object.size,
        contentType: object.httpMetadata?.contentType ?? "",
      })),
      next: result.truncated ? result.cursor : null,
    });
  }

  async function get(url: URL): Promise<Response> {
    const key = objectKey(url);
    if (key instanceof Response) return key;

    const object = await bucket.get(key);
    if (object === null) return notFound();
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type":
          object.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE,
      },
    });
  }

  async function put(req: Request, url: URL): Promise<Response> {
    const key = objectKey(url);
    if (key instanceof Response) return key;

    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_R2_OBJECT_BYTES) {
      return errorCode("BACKUP_OBJECT_TOO_LARGE", 413);
    }

    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_R2_OBJECT_BYTES) {
      return errorCode("BACKUP_OBJECT_TOO_LARGE", 413);
    }

    await bucket.put(key, body, {
      httpMetadata: {
        contentType:
          req.headers.get("content-type") ?? DEFAULT_CONTENT_TYPE,
      },
    });
    return noContent();
  }

  async function remove(url: URL): Promise<Response> {
    const key = objectKey(url);
    if (key instanceof Response) return key;

    await bucket.delete(key);
    return noContent();
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === LIST_PATH && req.method === "GET") {
        return list(url);
      }
      if (url.pathname === OBJECT_PATH) {
        if (req.method === "GET") return get(url);
        if (req.method === "PUT") return put(req, url);
        if (req.method === "DELETE") return remove(url);
      }
      return notFound();
    },
  };
}
