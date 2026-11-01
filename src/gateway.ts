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
    const event = await deps.adapter.parseInbound(req);
    if (!event) return ok();

    if (!deps.isOwner(Number(event.userId))) {
      console.warn(`gateway: ignoring event from non-owner ${event.userId}`);
      return ok();
    }

    if (event.type === "message") {
      // Telegram retries slow webhooks; acknowledge now and let the Butler run.
      ctx.waitUntil(deps.butler().onMessage(event));
      return ok();
    }

    const text = await deps.task(event.taskId).handleAction(event);
    await deps.adapter.answerAction(event.actionId, text);
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

    return new Response(object.body, {
      headers: {
        "content-type":
          object.httpMetadata?.contentType ?? "application/octet-stream",
      },
    });
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
