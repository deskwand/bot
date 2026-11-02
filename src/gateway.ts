export type GatewayDeps = {
  channels(): {
    handleTelegramWebhook(req: Request): Promise<"accepted" | "maintenance">;
  };
  artifacts: R2Bucket;
  admin: { fetch(req: Request): Promise<Response> };
};

const ARTIFACT_PREFIX = "/a/";

/** Types safe to display inline; everything else is a download. */
const INLINE_CONTENT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ok(): Response {
  return new Response(null, { status: 200 });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

export function createGateway(deps: GatewayDeps): {
  fetch(req: Request): Promise<Response>;
} {
  async function handleWebhook(req: Request): Promise<Response> {
    // Telegram retries failed deliveries; always acknowledge and log instead.
    let outcome: "accepted" | "maintenance";
    try {
      outcome = await deps.channels().handleTelegramWebhook(req);
    } catch (error) {
      console.error(`gateway: webhook forward failed: ${errorMessage(error)}`);
      return ok();
    }
    if (outcome === "maintenance") {
      return new Response("Service Unavailable", { status: 503 });
    }
    return ok();
  }

  async function handleArtifact(rawKey: string): Promise<Response> {
    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      return notFound();
    }
    if (!key) return notFound();

    const object = await deps.artifacts.get(key);
    if (!object) return notFound();

    const served =
      object.httpMetadata?.contentType ?? "application/octet-stream";
    const mime = served.split(";")[0]!.trim().toLowerCase();
    const headers = new Headers({
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    });

    if (INLINE_CONTENT_TYPES.has(mime)) {
      headers.set("content-type", served);
    } else {
      headers.set("content-type", "application/octet-stream");
      headers.set("content-disposition", "attachment");
    }

    return new Response(object.body, { headers });
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/admin/")) {
        return deps.admin.fetch(req);
      }

      if (req.method === "POST" && url.pathname === "/telegram/webhook") {
        return handleWebhook(req);
      }

      if (req.method === "GET" && url.pathname.startsWith(ARTIFACT_PREFIX)) {
        return handleArtifact(url.pathname.slice(ARTIFACT_PREFIX.length));
      }

      return notFound();
    },
  };
}
