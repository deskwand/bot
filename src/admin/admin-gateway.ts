/**
 * Authenticated `/admin/*` entry point for the desktop client's backups.
 *
 * Nothing here is reachable unless the deployment sets the `ADMIN_TOKEN`
 * secret: without it every path answers 404, so the route's existence is not
 * exposed. Every operation except acquiring the lease renews the maintenance
 * lease on both the Butler and the Channel hub before touching data.
 */

import type { BotDO } from "../bot/bot-do";
import type { ButlerDO } from "../butler/butler-do";
import type { ChannelDO } from "../channels/channel-do";
import type { McpAuthDO } from "../mcp/mcp-auth-do";
import type { TaskDO } from "../task/task-do";
import { createMcpAdminRoutes } from "./mcp-routes";
import { createR2Routes } from "./r2-routes";
import type {
  DbSchema,
  DumpPage,
  DumpRow,
  TableSchema,
} from "./sql-dump";

export type AdminDeps = {
  token: string | undefined;
  versionId: string;
  butler(): DurableObjectStub<ButlerDO>;
  channel(): DurableObjectStub<ChannelDO>;
  task(id: string): DurableObjectStub<TaskDO>;
  bot(id: string): DurableObjectStub<BotDO>;
  artifacts: R2Bucket;
  mcpAuth(): DurableObjectStub<McpAuthDO>;
};

/** The DO RPC surface used by the backup and restore routes. */
type BackupStub = {
  backupSchema(): Promise<DbSchema>;
  backupPage(table: TableSchema, cursor: string | null): Promise<DumpPage>;
  restoreBegin(schema: DbSchema): Promise<void>;
  restorePage(table: TableSchema, rows: DumpRow[]): Promise<void>;
  restoreCommit(schema: DbSchema): Promise<void>;
  restoreReset(): Promise<void>;
};

const OP_HEADER = "X-Backup-Op";

const ACQUIRE_PATH = "/admin/maintenance/acquire";
const RELEASE_PATH = "/admin/maintenance/release";
const INFO_PATH = "/admin/backup/info";
const SCHEMA_PATH = "/admin/backup/schema";
const PAGE_PATH = "/admin/backup/page";
const RESTORE_BEGIN_PATH = "/admin/restore/begin";
const RESTORE_PAGE_PATH = "/admin/restore/page";
const RESTORE_COMMIT_PATH = "/admin/restore/commit";
const RESTORE_RESET_PATH = "/admin/restore/reset";
const R2_PREFIX = "/admin/r2/";

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

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer (.+)$/i.exec(header);
  return match ? match[1]! : null;
}

/** SHA-256 makes both inputs the same length before the constant-time check. */
async function tokenMatches(
  expected: string,
  presented: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function backupStub(deps: AdminDeps, url: URL): BackupStub | Response {
  const kind = url.searchParams.get("do");
  const id = url.searchParams.get("id") ?? "";
  switch (kind) {
    case "butler":
      return deps.butler();
    case "channel":
      return deps.channel();
    case "task":
      return deps.task(id);
    case "bot":
      return deps.bot(id);
    default:
      return json(
        { code: "BACKUP_INVALID", message: `unknown do kind: ${kind ?? ""}` },
        400,
      );
  }
}

async function readBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function invalid(message: string): Response {
  return json({ code: "BACKUP_INVALID", message }, 400);
}

/**
 * Renews the lease on both objects. Returns null when the request may proceed,
 * or the 409 response to send instead.
 */
export async function requireLease(
  deps: AdminDeps,
  req: Request,
): Promise<Response | null> {
  const opId = req.headers.get(OP_HEADER);
  if (opId === null || opId === "") {
    return errorCode("MAINTENANCE_REQUIRED", 409);
  }
  const [butler, channel] = await Promise.all([
    deps.butler().renewMaintenance(opId),
    deps.channel().renewMaintenance(opId),
  ]);
  if (!butler || !channel) {
    return errorCode("MAINTENANCE_REQUIRED", 409);
  }
  return null;
}

async function acquire(deps: AdminDeps, req: Request): Promise<Response> {
  const body = await readBody<{ op?: unknown; opId?: unknown }>(req);
  if (
    body === null ||
    (body.op !== "export" && body.op !== "restore") ||
    typeof body.opId !== "string" ||
    body.opId === ""
  ) {
    return invalid("acquire needs { op, opId }");
  }

  const butler = deps.butler();
  const channel = deps.channel();
  const first = await butler.acquireMaintenance(body.op, body.opId);
  if (first === "busy") return errorCode("MAINTENANCE_BUSY", 409);

  let second: Awaited<ReturnType<typeof channel.acquireMaintenance>>;
  try {
    second = await channel.acquireMaintenance(body.op, body.opId);
  } catch (error) {
    // Do not leave the Butler half-acquired when the hub fails.
    try {
      await butler.releaseMaintenance(body.opId);
    } catch {
      // The original error is the useful one.
    }
    throw error;
  }
  if (second === "busy") {
    // Do not leave a half-acquired lease behind when the hub refuses.
    await butler.releaseMaintenance(body.opId);
    return errorCode("MAINTENANCE_BUSY", 409);
  }
  return json({ until: first.until });
}

async function release(deps: AdminDeps, req: Request): Promise<Response> {
  const opId = req.headers.get(OP_HEADER);
  // Releasing is best effort and needs no live lease: the store deletes only
  // the matching opId, so a stale client cannot cancel someone else's run.
  if (opId !== null && opId !== "") {
    await Promise.all([
      deps.butler().releaseMaintenance(opId),
      deps.channel().releaseMaintenance(opId),
    ]);
  }
  return noContent();
}

export function createAdminGateway(deps: AdminDeps): {
  fetch(req: Request): Promise<Response>;
} {
  const r2 = createR2Routes(deps.artifacts);
  const mcp = createMcpAdminRoutes(deps.mcpAuth);

  async function handle(req: Request, url: URL): Promise<Response> {
    if (req.method === "POST" && url.pathname === ACQUIRE_PATH) {
      return acquire(deps, req);
    }
    if (req.method === "POST" && url.pathname === RELEASE_PATH) {
      return release(deps, req);
    }

    // MCP management works during backup/restore and needs no lease.
    if (url.pathname.startsWith("/admin/mcp/")) {
      return mcp.fetch(req);
    }

    if (url.pathname.startsWith(R2_PREFIX)) {
      const denied = await requireLease(deps, req);
      if (denied !== null) return denied;
      return r2.fetch(req);
    }

    const known =
      url.pathname === INFO_PATH ||
      url.pathname === SCHEMA_PATH ||
      url.pathname === PAGE_PATH ||
      url.pathname === RESTORE_BEGIN_PATH ||
      url.pathname === RESTORE_PAGE_PATH ||
      url.pathname === RESTORE_COMMIT_PATH ||
      url.pathname === RESTORE_RESET_PATH;
    if (!known) return notFound();

    const denied = await requireLease(deps, req);
    if (denied !== null) return denied;

    if (req.method === "GET" && url.pathname === INFO_PATH) {
      return json({
        versionId: deps.versionId,
        taskIds: await deps.butler().listTaskIds(),
        botIds: await deps.butler().listBotIds(),
      });
    }

    if (req.method === "GET" && url.pathname === SCHEMA_PATH) {
      const target = backupStub(deps, url);
      if (target instanceof Response) return target;
      return json(await target.backupSchema());
    }

    if (req.method === "POST" && url.pathname === PAGE_PATH) {
      const target = backupStub(deps, url);
      if (target instanceof Response) return target;
      const body = await readBody<{
        table?: TableSchema;
        cursor?: string | null;
      }>(req);
      if (
        body === null ||
        typeof body.table !== "object" ||
        body.table === null
      ) {
        return invalid("page needs { table, cursor }");
      }
      const page = await target.backupPage(body.table, body.cursor ?? null);
      return json(page);
    }

    if (req.method === "POST" && url.pathname === RESTORE_BEGIN_PATH) {
      const target = backupStub(deps, url);
      if (target instanceof Response) return target;
      const body = await readBody<{ schema?: DbSchema }>(req);
      if (
        body === null ||
        typeof body.schema !== "object" ||
        body.schema === null
      ) {
        return invalid("restore begin needs { schema }");
      }
      await target.restoreBegin(body.schema);
      return noContent();
    }

    if (req.method === "POST" && url.pathname === RESTORE_PAGE_PATH) {
      const target = backupStub(deps, url);
      if (target instanceof Response) return target;
      const body = await readBody<{ table?: TableSchema; rows?: DumpRow[] }>(
        req,
      );
      if (
        body === null ||
        typeof body.table !== "object" ||
        body.table === null ||
        !Array.isArray(body.rows)
      ) {
        return invalid("restore page needs { table, rows }");
      }
      await target.restorePage(body.table, body.rows);
      return noContent();
    }

    if (req.method === "POST" && url.pathname === RESTORE_COMMIT_PATH) {
      const target = backupStub(deps, url);
      if (target instanceof Response) return target;
      const body = await readBody<{ schema?: DbSchema }>(req);
      if (
        body === null ||
        typeof body.schema !== "object" ||
        body.schema === null
      ) {
        return invalid("restore commit needs { schema }");
      }
      await target.restoreCommit(body.schema);
      return noContent();
    }

    if (req.method === "POST" && url.pathname === RESTORE_RESET_PATH) {
      const target = backupStub(deps, url);
      if (target instanceof Response) return target;
      try {
        await target.restoreReset();
      } catch {
        // Aborting the object rejects the in-flight RPC; that is the point.
      }
      return noContent();
    }

    return notFound();
  }

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/admin/")) return notFound();
      if (deps.token === undefined || deps.token === "") return notFound();

      try {
        const presented = bearerToken(req);
        if (
          presented === null ||
          !(await tokenMatches(deps.token, presented))
        ) {
          return errorCode("ADMIN_UNAUTHORIZED", 401);
        }

        return await handle(req, url);
      } catch {
        // Never echo the thrown error: it may contain tokens or raw SQL.
        return json(
          { code: "BACKUP_INVALID", message: "backup request failed" },
          500,
        );
      }
    },
  };
}
