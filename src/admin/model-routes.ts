/**
 * Subscription login routes: the desktop starts a device-code login, polls it
 * until the owner finishes in the browser, and can disconnect again.
 *
 * Only subscription providers exist here; today that is `openai-codex`. The
 * routes are stateless: the device-auth pair is handed to the desktop and
 * returned on every poll, so a Worker restart cannot strand a pending login.
 */

import { SUBSCRIPTION_PROVIDER_IDS } from "../llm/providers";
import type { CodexLoginPoll, CodexLoginStart } from "../llm/codex";

export const MODEL_AUTH_PREFIX = "/admin/models/auth";

/**
 * The deps take no provider id: the routes accept exactly one subscription
 * provider today (`openai-codex`), and a second one turns these into
 * `start(provider)` / `poll(provider, device)` / `disconnect(provider)`.
 */
export type ModelAuthDeps = {
  status(): Promise<{ id: string; connected: boolean }[]>;
  start(): Promise<CodexLoginStart>;
  poll(device: { deviceAuthId: string; userCode: string }): Promise<CodexLoginPoll>;
  disconnect(): Promise<void>;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function invalid(message: string): Response {
  return json({ code: "MODEL_AUTH_INVALID", message }, 400);
}

/** Upstream failures stay opaque; only a fixed code reaches the desktop. */
function failed(): Response {
  return json({ code: "MODEL_AUTH_FAILED", message: "model login request failed" }, 502);
}

async function readDevice(
  req: Request,
): Promise<{ deviceAuthId: string; userCode: string } | null> {
  try {
    const body = (await req.json()) as {
      deviceAuthId?: unknown;
      userCode?: unknown;
    };
    if (
      typeof body.deviceAuthId !== "string" ||
      body.deviceAuthId === "" ||
      typeof body.userCode !== "string" ||
      body.userCode === ""
    ) {
      return null;
    }
    return { deviceAuthId: body.deviceAuthId, userCode: body.userCode };
  } catch {
    return null;
  }
}

export function createModelAuthRoutes(deps: ModelAuthDeps): {
  fetch(req: Request): Promise<Response>;
} {
  async function handle(req: Request, url: URL): Promise<Response> {
    if (url.pathname === MODEL_AUTH_PREFIX) {
      if (req.method !== "GET") return notFound();
      try {
        return json({ providers: await deps.status() });
      } catch {
        return failed();
      }
    }

    const rest = url.pathname.slice(MODEL_AUTH_PREFIX.length + 1);
    const slash = rest.indexOf("/");
    let provider: string;
    try {
      provider = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    } catch {
      return notFound();
    }
    const action = slash === -1 ? "" : rest.slice(slash + 1);

    if (!SUBSCRIPTION_PROVIDER_IDS.has(provider)) {
      return json({ code: "MODEL_AUTH_UNKNOWN_PROVIDER" }, 404);
    }

    if (action === "start" && req.method === "POST") {
      try {
        return json(await deps.start());
      } catch (error) {
        console.error("model login start failed:", error);
        return failed();
      }
    }

    if (action === "poll" && req.method === "POST") {
      const device = await readDevice(req);
      if (device === null) return invalid("poll needs { deviceAuthId, userCode }");
      try {
        return json(await deps.poll(device));
      } catch (error) {
        console.error("model login poll failed:", error);
        return failed();
      }
    }

    if (action === "" && req.method === "DELETE") {
      try {
        await deps.disconnect();
      } catch (error) {
        console.error("model logout failed:", error);
        return failed();
      }
      return new Response(null, { status: 204 });
    }

    return notFound();
  }

  return {
    fetch(req: Request): Promise<Response> {
      return handle(req, new URL(req.url));
    },
  };
}
