/**
 * Authenticated `/admin/*` entry point for the desktop client's backups.
 *
 * Nothing here is reachable unless the deployment sets the `ADMIN_TOKEN`
 * secret: without it every path answers 404, so the route's existence is not
 * exposed. Every operation except acquiring the lease renews the maintenance
 * lease on both the Butler and the Channel hub before touching data.
 */

import type { ArtifactStore } from "../artifact-store";
import type { BrowserClient } from "../sandbox/browser-http";
import type { BotDO } from "../bot/bot-do";
import type { ButlerDO } from "../butler/butler-do";
import type { ChannelDO } from "../channels/channel-do";
import type { Locale } from "../i18n";
import type { LifeDO } from "../life/life-do";
import type { McpAuthDO } from "../mcp/mcp-auth-do";
import type { TaskDO } from "../task/task-do";
import type { WalletDO } from "../wallet/wallet-do";
import {
  createExchangeRoutes,
  type ExchangeProbeResult,
} from "./exchange-routes";
import { createWalletRoutes, type WalletReads } from "./wallet-routes";
import {
  CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  readBatch,
  type BatchState,
} from "./backup-batch";
import { BROWSER_PREFIX, createBrowserAdminRoutes } from "./browser-routes";
import { createLifeRoutes } from "./life-routes";
import {
  createModelAuthRoutes,
  MODEL_AUTH_PREFIX,
  type ModelAuthDeps,
} from "./model-routes";
import { BOTS_PATH, createBotRoutes } from "./bot-routes";
import { createMcpAdminRoutes } from "./mcp-routes";
import { createOwnerRoutes, OWNER_STATUS_PATH } from "./owner-routes";
import { createMemberAdminRoutes, MEMBERS_PATH } from "./member-routes";
import { createChannelAdminRoutes, CHANNELS_PATH } from "./channel-routes";
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
  /** `id` selects a member Butler; absent means the owner. */
  butler(id?: string): DurableObjectStub<ButlerDO>;
  channel(): DurableObjectStub<ChannelDO>;
  task(id: string): DurableObjectStub<TaskDO>;
  bot(id: string): DurableObjectStub<BotDO>;
  life(): DurableObjectStub<LifeDO>;
  wallet(): DurableObjectStub<WalletDO>;
  artifacts: ArtifactStore;
  mcpAuth(): DurableObjectStub<McpAuthDO>;
  locale?: () => Locale;
  /** Present only when the deployment wires the exchange probe. */
  probeExchange?(account: string): Promise<ExchangeProbeResult>;
  /** Present only when the deployment wires the desktop snapshot push. */
  ingestExchangeSnapshot?(body: unknown): Promise<ExchangeProbeResult>;
  /** Present only when the deployment wires the wallet status route. */
  walletReads?: WalletReads;
  /** Present only when the deployment wires subscription model logins. */
  modelAuth?: ModelAuthDeps;
  /** Null when the deployment has no sandbox; the page then says so. */
  browser?: BrowserClient | null;
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
const CHUNK_PATH = "/admin/backup/chunk";
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
      // A member Butler id must reach that member's object: serving the owner
      // here would mix private conversations into the wrong archive segment.
      return deps.butler(id === "" ? undefined : id);
    case "channel":
      return deps.channel();
    case "task":
      return deps.task(id);
    case "bot":
      return deps.bot(id);
    case "life":
      return deps.life();
    case "wallet":
      return deps.wallet();
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
    deps.butler(undefined).renewMaintenance(opId),
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

  const butler = deps.butler(undefined);
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
      deps.butler(undefined).releaseMaintenance(opId),
      deps.channel().releaseMaintenance(opId),
    ]);
  }
  return noContent();
}

export function createAdminGateway(deps: AdminDeps): {
  fetch(req: Request): Promise<Response>;
} {
  const r2 = createR2Routes(deps.artifacts);
  const mcp = createMcpAdminRoutes(deps.mcpAuth, deps.locale);
  const probe = deps.probeExchange;
  const exchange =
    probe === undefined
      ? null
      : createExchangeRoutes({
          probe,
          ingest: deps.ingestExchangeSnapshot,
        });
  const wallet =
    deps.walletReads === undefined ? null : createWalletRoutes(deps.walletReads);
  const modelAuth =
    deps.modelAuth === undefined ? null : createModelAuthRoutes(deps.modelAuth);
  const life = createLifeRoutes({ vitals: () => deps.life().vitals() });
  const browser =
    deps.browser === undefined ? null : createBrowserAdminRoutes({ client: deps.browser });
  const owner = createOwnerRoutes({
    status: () => deps.channel().ownerStatus(),
    open: () => deps.channel().openOwnerClaim(),
    revoke: () => deps.channel().revokeOwner(),
  });
  const members = createChannelAdminRoutes({ channel: () => deps.channel() });
  const bots = createBotRoutes({
    overview: () => deps.butler(undefined).botsOverview(),
    snapshot: (id) => deps.bot(id).snapshot(),
  });

  async function handle(req: Request, url: URL): Promise<Response> {
    if (req.method === "POST" && url.pathname === ACQUIRE_PATH) {
      return acquire(deps, req);
    }
    if (req.method === "POST" && url.pathname === RELEASE_PATH) {
      return release(deps, req);
    }

    if (
      url.pathname === MEMBERS_PATH ||
      url.pathname.startsWith(`${MEMBERS_PATH}/`) ||
      url.pathname === CHANNELS_PATH ||
      url.pathname.startsWith(`${CHANNELS_PATH}/`)
    ) {
      return members.fetch(req);
    }

    // MCP management works during backup/restore and needs no lease.
    if (url.pathname.startsWith("/admin/mcp/")) {
      return mcp.fetch(req);
    }

    // Takeover is forwarded straight to the sandbox; the sandbox owns the tab.
    if (url.pathname.startsWith(BROWSER_PREFIX) && browser !== null) {
      return browser.fetch(req);
    }

    // Exchange probing is a read-only health check and needs no lease.
    if (url.pathname.startsWith("/admin/exchange/") && exchange !== null) {
      return exchange.fetch(req);
    }

    // Wallet status is a read-only health check and needs no lease.
    if (url.pathname.startsWith("/admin/wallet/") && wallet !== null) {
      return wallet.fetch(req);
    }

    // Subscription logins touch no user data; the prompts themselves live in
    // the service, and the credential is written by the poll.
    if (
      modelAuth !== null &&
      (url.pathname === MODEL_AUTH_PREFIX ||
        url.pathname.startsWith(`${MODEL_AUTH_PREFIX}/`))
    ) {
      return modelAuth.fetch(req);
    }

    // Vitals are a read-only health check and need no lease.
    if (url.pathname.startsWith("/admin/life/")) {
      return life.fetch(req);
    }
    // 读状态是只读的，不加锁；开窗/撤销会写认领表并清地址，必须持维护租约。
    if (url.pathname === OWNER_STATUS_PATH) return owner.fetch(req);
    if (url.pathname.startsWith("/admin/owner/")) {
      const denied = await requireLease(deps, req);
      if (denied !== null) return denied;
      return owner.fetch(req);
    }

    // Bots are read-only and need no lease, so the page works during a backup.
    if (url.pathname === BOTS_PATH || url.pathname.startsWith(`${BOTS_PATH}/`)) {
      return bots.fetch(req);
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
      url.pathname === CHUNK_PATH ||
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
        taskIds: await deps.butler(undefined).listTaskIds(),
        botIds: await deps.butler(undefined).listBotIds(),
        // Non-owner members, including revoked ones: a backup that skipped
        // them would silently drop their history.
        memberIds: await deps.channel().memberIds(),
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

    if (req.method === "POST" && url.pathname === CHUNK_PATH) {
      const target = backupStub(deps, url);
      if (target instanceof Response) return target;
      const body = await readBody<{
        tables?: TableSchema[];
        state?: BatchState;
        budgetBytes?: number;
      }>(req);
      if (
        body === null ||
        !Array.isArray(body.tables) ||
        body.tables.length === 0
      ) {
        return invalid("chunk needs { tables, state, budgetBytes }");
      }
      const state = body.state ?? { index: 0, cursor: null };
      if (
        typeof state.index !== "number" ||
        !Number.isInteger(state.index) ||
        state.index < 0 ||
        state.index >= body.tables.length ||
        (state.cursor !== null && typeof state.cursor !== "string")
      ) {
        return invalid("chunk state index out of range");
      }
      const budget =
        typeof body.budgetBytes === "number" && body.budgetBytes > 0
          ? Math.min(body.budgetBytes, MAX_CHUNK_BYTES)
          : CHUNK_BYTES;
      return json(await readBatch(target, body.tables, state, budget));
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
