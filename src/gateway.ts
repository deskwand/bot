import type { ChannelAdapter } from "./channels/types";
import type { ActionEvent, MessageEvent } from "./protocol";

export type GatewayDeps = {
  adapter: ChannelAdapter;
  isOwner(userId: number): boolean;
  butler(): { onMessage(evt: MessageEvent): Promise<void> };
  task(taskId: string): { handleAction(evt: ActionEvent): Promise<string> };
  artifacts: R2Bucket;
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
  fetch(req: Request, ctx: ExecutionContext): Promise<Response>;
} {
  async function handleWebhook(
    req: Request,
    ctx: ExecutionContext,
  ): Promise<Response> {
    let event;
    try {
      event = await deps.adapter.parseInbound(req);
    } catch (error) {
      console.error(`gateway: failed to parse update: ${errorMessage(error)}`);
      return ok();
    }
    if (!event) return ok();

    if (!deps.isOwner(Number(event.userId))) {
      console.warn(`gateway: ignoring event from non-owner ${event.userId}`);
      return ok();
    }

    if (event.type === "message") {
      // Telegram retries slow webhooks; acknowledge now and let the Butler run.
      try {
        ctx.waitUntil(deps.butler().onMessage(event));
      } catch (error) {
        console.error(`gateway: message dispatch failed: ${errorMessage(error)}`);
      }
      return ok();
    }

    let text = "出错了，稍后再试";
    try {
      text = await deps.task(event.taskId).handleAction(event);
    } catch (error) {
      console.error(`gateway: action failed: ${errorMessage(error)}`);
    }

    try {
      await deps.adapter.answerAction(event.actionId, text);
    } catch (error) {
      console.error(
        `gateway: answer callback failed: ${errorMessage(error)}`,
      );
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
    async fetch(req: Request, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname === "/telegram/webhook") {
        return handleWebhook(req, ctx);
      }

      if (req.method === "GET" && url.pathname.startsWith(ARTIFACT_PREFIX)) {
        return handleArtifact(url.pathname.slice(ARTIFACT_PREFIX.length));
      }

      return notFound();
    },
  };
}
