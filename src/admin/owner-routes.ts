/**
 * 主人认领状态的管理接口。鉴权在 admin-gateway 里统一做（bearer +
 * tokenMatches），这里只管方法/路径分派与错误码。
 */
import type { OwnerStatus } from "../channels/owner-access";

export type { OwnerStatus };

export const OWNER_STATUS_PATH = "/admin/owner/status";
export const OWNER_OPEN_PATH = "/admin/owner/open";
export const OWNER_REVOKE_PATH = "/admin/owner/revoke";

export type OwnerReads = {
  status(): Promise<OwnerStatus>;
  open(): Promise<OwnerStatus>;
  revoke(): Promise<OwnerStatus>;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function createOwnerRoutes(reads: OwnerReads): {
  fetch(req: Request): Promise<Response>;
} {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const isGet = req.method === "GET";
      const isPost = req.method === "POST";

      if (url.pathname === OWNER_STATUS_PATH) {
        if (!isGet) return new Response("Method not allowed", { status: 405 });
        try {
          return json(await reads.status());
        } catch {
          return json({ code: "OWNER_STATUS_FAILED" }, 503);
        }
      }
      if (url.pathname === OWNER_OPEN_PATH) {
        if (!isPost) return new Response("Method not allowed", { status: 405 });
        try {
          return json(await reads.open());
        } catch {
          return json({ code: "OWNER_OPEN_FAILED" }, 503);
        }
      }
      if (url.pathname === OWNER_REVOKE_PATH) {
        if (!isPost) return new Response("Method not allowed", { status: 405 });
        try {
          return json(await reads.revoke());
        } catch {
          return json({ code: "OWNER_REVOKE_FAILED" }, 503);
        }
      }
      return new Response("Not found", { status: 404 });
    },
  };
}
