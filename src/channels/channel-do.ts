import { Agent, type Schedule } from "agents";
import { BackupRpc } from "../admin/backup-rpc";
import { DEFER_MS, MaintenanceStore, type Lease } from "../admin/maintenance";
import type {
  DbSchema,
  DumpPage,
  DumpRow,
  TableSchema,
} from "../admin/sql-dump";
import { MAX_ARTIFACT_BYTES, artifactKeySegments, artifactNameFromKey } from "../artifact";
import { artifactStore } from "../artifact-store";
import { actionHint } from "../butler/owner-copy";
import { ownerLocale, t, type Locale } from "../i18n";
import { readRuntimeConfig } from "../runtime-config";
import { classifyFile, extensionForMime } from "../tools/file-content";
import {
  decodeAction,
  type ActionEvent,
  type AdmittedMessage,
  type ChannelId,
  type ChannelMessageRef,
  type InboundEvent,
  type InboundFile,
  type MessageEvent,
  type OutboundMessage,
  type RouteSnapshot,
} from "../protocol";
import {
  getChannelOverride,
  getILinkFetchOverride,
  getMemberButlerOverride,
  getPollTimingOverride,
  getTelegramFetchOverride,
  getWeChatCredentialsOverride,
  type MemberButlerRpc,
} from "./override";
import {
  DISABLED_ROUTE_KEY,
  memberRouteIdentity,
  parseActiveChannel,
  routeIdentity,
  sha256Hex,
  versionIdOf,
} from "./route-identity";
import { emitChannelEvent } from "./events";
import {
  decideOwner,
  ownerStatusOf,
  type OwnerClaimView,
  type OwnerConfigView,
  type OwnerDecision,
  type OwnerStatus,
} from "./owner-access";
import { OwnerStore } from "./owner-store";
import {
  AttachmentAccess,
  migrateLegacyInbox,
} from "../members/artifact-access";
import {
  CredentialStaging,
  CredentialVault,
  inviteTokenKey,
  stageCredentialAndActivate,
} from "../members/credentials";
import { MemberAccessClient } from "../members/client";
import {
  ShareService,
  parseShareCommand,
  shareErrorText,
  type ShareCommand,
  type SharePreview,
  type ShareResult,
} from "../members/shares";
import {
  OWNER_ID,
  butlerName,
  ownerPrincipal,
  type ConnectionRef,
  type Principal,
} from "../members/principal";
import {
  INVITE_NOT_FOUND,
  MEMBER_ACCESS_DENIED,
  MemberError,
  MemberStore,
  type CreateInviteOptions,
  type MemberInviteLink,
  type MemberView,
} from "../members/store";
import { inboxStore } from "./inbox";
import { OutboundQueue } from "./outbound-queue";
import { describeImageBytes, prepareInboundImage, sniffImageType } from "./media";
import { createTelegramAdapter } from "./telegram";
import {
  createTelegramPollClient,
  type TelegramUpdateBatch,
} from "./telegram-poll";
import { parseTextAction, textHint, type TextAction } from "./text-action";
import { ChannelError, type ChannelAdapter, type OutboundArtifact } from "./types";
import { withRetry } from "./retry";
import { adminInviteView, type AdminInviteView } from "../members/admin-view";
import { ConnectionStore, contextKey } from "./wechat/connections";
import { PRIVATE_WECHAT_PREFIX } from "../members/credentials";
import { toWeChatText } from "./wechat/markdown";
import {
  SqlLoginStateStore,
  VaultLoginSecretStore,
  WeChatLogin,
} from "./wechat/login";
import {
  createILinkClient,
  ILinkError,
  isSessionExpired,
  isTrustedBaseUrl,
  parseCredentials,
  type WeChatCredentials,
  type WeChatFileRef,
  type WeChatMediaItem,
  type WeChatUpdate,
} from "./wechat/ilink";
import type { WeChatImageRef } from "./wechat/media";

// One long poll per alarm, then a hand-off to the next alarm. A long run in
// one alarm survives a deploy on the superseded isolate: observed in production,
// the old run stalled for minutes before the platform reset it, and no poll ran
// meanwhile. A short alarm lets the next poll start on the new code.
const WECHAT_POLL_RUN_MS = 0;
const WECHAT_POLL_BACKOFF_MS = 1_000;
const WECHAT_POLL_MAX_BACKOFF_MS = 10_000;
const WECHAT_GET_UPDATES_TIMEOUT_MS = 40_000;
// Skip the pre-poll heartbeat while it is fresh: the write after the previous
// long poll is enough to keep ensurePolling from starting a second chain.
const WECHAT_PREPOLL_HEARTBEAT_MS = 20_000;
// One long poll (40s) plus a skipped pre-poll write (20s) plus the longest
// backoff (10s) stays under this, so a live chain is never doubled, and a dead
// one is revived by the per-minute Cron within about 75s plus one Cron tick.
const WECHAT_HEARTBEAT_MAX_AGE_MS = 75_000;
const TELEGRAM_POLL_RUN_MS = 0;
const TELEGRAM_POLL_BACKOFF_MS = 1_000;
const TELEGRAM_POLL_MAX_BACKOFF_MS = 10_000;
const TELEGRAM_GET_UPDATES_TIMEOUT_MS = 35_000;
const TELEGRAM_HEARTBEAT_MAX_AGE_MS = 60_000;
/** How many drains a rejected message survives before it is given up on. */
const OUTBOUND_MAX_ATTEMPTS = 5;
type WeChatState = {
  credentials_hash: string | null;
  cursor: string | null;
  status: string | null;
  last_poll_at: number | null;
  expiry_notified: number;
};
type TelegramState = {
  token_hash: string | null;
  offset: number;
  status: string | null;
  last_poll_at: number | null;
  expired_version: string | null;
};
type TelegramPollClient = ReturnType<typeof createTelegramPollClient>;
type TelegramWebhookRetry = {
  attempted: boolean;
};

/**
 * The member a media download is admitted for. Present only on the member
 * path: the owner path passes nothing and keeps its legacy behaviour. The CDN
 * object is unauthenticated, so what the download needs is exactly this —
 * whose admission decides whether the bytes may be stored or dispatched.
 */
type MediaTrust = { actor: Principal; ref: ConnectionRef };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function credentialsHash(json: string): Promise<string> {
  return sha256Hex(json);
}

/**
 * A one-time binding token: 32 random bytes, base64url without padding. It is
 * handed over only inside the link fragment and kept in the vault; SQL stores
 * its SHA-256 digest.
 */
function inviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The link the owner forwards; the token lives in the fragment, never a query. */
function memberBindUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/members/bind/#${token}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `{connectionId, generation}` payload every member poll carries. */
function connectionPayload(
  payload: unknown,
): { connectionId: string; generation: number } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const connectionId = record.connectionId;
  const generation = record.generation;
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    return null;
  }
  if (typeof generation !== "number" || !Number.isInteger(generation)) {
    return null;
  }
  return { connectionId, generation };
}

export function channelDisabledText(locale: Locale): string {
  return t(locale, "channel.disabled");
}

export function channelErrorText(locale: Locale): string {
  return t(locale, "channel.error");
}

/**
 * Maps an iLink/Telegram/network failure to a fixed diagnostic code. The raw
 * error text is never logged as an event field.
 */
function channelErrorCode(error: unknown): string {
  // Only iLink uses status 0 to mean an untrusted origin. A status-0
  // `ChannelError` maps to `network_error` below, as it did before.
  if (error instanceof ILinkError && error.status === 0) {
    return "untrusted_origin";
  }
  if (error instanceof ILinkError || error instanceof ChannelError) {
    if (error.status === 429) return "rate_limited";
    if (error.status >= 500) return "upstream_error";
    if (error.status !== 0) return "api_error";
  }
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return "network_timeout";
  }
  return "network_error";
}

/** Drop buttons and turn each one into an instruction the owner can type. */
function forWechat(msg: OutboundMessage, locale: Locale): OutboundMessage {
  const text = toWeChatText(msg.text);
  if (!msg.buttons || msg.buttons.length === 0) return { text };

  const hints: string[] = [];
  for (const row of msg.buttons) {
    for (const button of row) {
      // The sender knows the display handle, which the encoded data cannot.
      if (button.hint !== undefined) {
        hints.push(textHint(locale, button.hint));
        continue;
      }
      const decoded = decodeAction(button.data);
      if (!decoded) continue;
      hints.push(
        textHint(
          locale,
          actionHint(locale, decoded.action, {
            taskId: decoded.taskId,
            ...(decoded.approvalId === undefined
              ? {}
              : { approvalId: decoded.approvalId }),
          }),
        ),
      );
    }
  }

  return hints.length === 0
    ? { text }
    : { text: `${text}\n${hints.join("\n")}` };
}

/** Replaces a whole `t<n>` id, so `t7` is not rewritten inside `t70`. */
function replaceTaskId(text: string, taskId: string, label: string): string {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\b${escaped}\\b`, "g"), label);
}

/**
 * Single channel hub: the only place that talks to a channel API, and the only
 * place inbound channel events enter the control plane.
 */
export class ChannelDO extends Agent<Env> {
  private readonly db: SqlStorage;

  private telegramInstance: ChannelAdapter | undefined;
  private activeWeChatRun: {
    hash: string;
    raw: string;
    routeKey: string;
  } | null = null;

  private activeTelegramRun: {
    token: string;
    hash: string;
    routeKey: string;
  } | null = null;

  /**
   * Error backoff carried across alarms: each alarm makes one poll, so the
   * doubling would otherwise restart at the base delay every time.
   */
  private weChatBackoffMs: number | null = null;

  private telegramBackoffMs: number | null = null;
  /** Cached for the lifetime of this instance: its environment is immutable. */
  private routePromise: Promise<RouteSnapshot> | undefined;

  private readonly lease: MaintenanceStore;

  private readonly backup: BackupRpc;

  private readonly owners: OwnerStore;

  private readonly members: MemberStore;

  private readonly attachments: AttachmentAccess;

  private readonly vault: CredentialVault;

  private readonly staging: CredentialStaging;

  private accessClientCache: MemberAccessClient | null = null;

  private shareServiceCache: ShareService | null = null;

  private readonly outbound: OutboundQueue;

  /** Single-flight guard: an inbound drain and a send-time drain must not run twice. */
  private outboundFlush: Promise<void> | null = null;

  /** A row was added while a drain was running, so one more pass is due. */
  private outboundAgain = false;

  /** Per-connection runtime state (address, poll clock, context pointer). */
  private readonly connections: ConnectionStore;

  /** One queue per member connection; a generation bump retires the old one. */
  private readonly memberQueues = new Map<
    string,
    { generation: number; queue: OutboundQueue }
  >();

  /** Per-connection drains: A's backlog or failure never joins B's drain. */
  private readonly memberOutboundFlush = new Map<string, Promise<void>>();

  private readonly memberOutboundAgain = new Set<string>();

  /** One live poll step per connection, so a chain is never doubled. */
  private readonly activeMemberWeChatRuns = new Map<
    string,
    { generation: number }
  >();

  private readonly memberWeChatBackoffMs = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = ctx.storage.sql;
    this.outbound = new OutboundQueue(this.db);
    this.lease = new MaintenanceStore(this.db);
    this.backup = new BackupRpc(ctx, this.lease);
    this.owners = new OwnerStore(this.db);
    // The directory tables exist from the first boot, Telegram-only and empty
    // stores included. The owner row grants nothing by itself: every legacy
    // ingress still passes through its own owner gate.
    // Directory writes that span statements run in one synchronous storage
    // transaction, so a failed SQL write rolls the whole activation back.
    this.members = new MemberStore(this.db, undefined, (fn) =>
      ctx.storage.transactionSync(fn),
    );
    this.members.ensureOwner();
    this.attachments = new AttachmentAccess(this.db);
    this.vault = new CredentialVault(ctx.storage);
    this.staging = new CredentialStaging(this.db, this.vault);
    // Member runtime state lives next to the directory; the context token is
    // written only to the vault behind this store.
    this.connections = new ConnectionStore(this.db, this.vault);

    this.db.exec(
      `CREATE TABLE IF NOT EXISTS owner_addresses (
        channel TEXT PRIMARY KEY,
        conversation_id TEXT,
        updated_at INTEGER
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS wechat_state (
        credentials_hash TEXT,
        cursor TEXT,
        status TEXT,
        last_poll_at INTEGER,
        expiry_notified INTEGER
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS telegram_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token_hash TEXT,
        offset INTEGER,
        status TEXT,
        last_poll_at INTEGER,
        expired_version TEXT
      )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS wechat_contexts (
        user_id TEXT PRIMARY KEY,
        context_token TEXT,
        updated_at INTEGER
      )`,
    );
  }

  override async onStart(props?: object): Promise<void> {
    await super.onStart(props);
    // A process that died between the vault write and the pointer move leaves
    // an unreferenced candidate. Drop those; a live pointer is never touched.
    try {
      const orphans = await this.staging.reconcile();
      if (orphans.length > 0) {
        console.warn(
          `channel: discarded ${orphans.length} orphaned credential(s)`,
        );
      }
    } catch (error) {
      console.error(
        `channel: credential reconciliation failed: ${errorMessage(error)}`,
      );
    }
    await this.migrateLegacyAttachments();
    // 认领窗口从 DO 第一次醒来开始计时（部署后几秒），而不是等有人打开桌面端
    // 的状态页 —— 读状态不该启动计时，也不该让窗口被动延后。
    try {
      if (this.ownerConfig().telegramUserIds === undefined) this.owners.ensureWindow();
    } catch (error) {
      // 配置缺失时 readRuntimeConfig 会抛；不能因此卡住 DO 启动。
      console.warn(`channel: claim window not opened: ${errorMessage(error)}`);
    }
    // First wake (any existing RPC or the Cron) applies the selection early.
    try {
      await this.ensurePolling();
    } catch (error) {
      console.error(`channel: startup polling failed: ${errorMessage(error)}`);
    }
  }

  async handleTelegramUpdate(
    update: unknown,
  ): Promise<"accepted" | "maintenance"> {
    if (this.lease.current() !== null) return "maintenance";

    try {
      const adapter = this.adapter("telegram");

      let event: InboundEvent | null;
      try {
        event = await adapter.parseInbound(update);
      } catch (error) {
        emitChannelEvent(this.env, {
          channel: "telegram",
          event: "webhook_rejected",
          errorCode: "payload_invalid",
        });
        console.error(
          `channel: failed to parse update: ${errorMessage(error)}`,
        );
        return "accepted";
      }
      if (!event) return "accepted";

      const access = this.ownerAccess(event);
      if (access === "deny") {
        console.warn(`channel: ignoring event from non-owner ${event.userId}`);
        return "accepted";
      }
      if (access === "claim") {
        await this.claimOwner(event);
      }

      this.rememberOwner(event, ownerPrincipal());

      // The other channel's input must not reach the Butler or a task.
      const route = await this.currentRoute();
      if (route.channel !== "telegram") {
        if (event.type === "action") {
          try {
            await adapter.answerAction(
              event.actionId,
              channelDisabledText(ownerLocale(this.env)),
            );
          } catch (error) {
            console.error(
              `channel: answer callback failed: ${errorMessage(error)}`,
            );
          }
        }
        return "accepted";
      }

      if (event.type === "message") {
        if (this.dispatchMessage(event, route.routeKey)) return "accepted";
        // A false result without a lease is a dispatch exception (already
        // logged); only a live lease asks the poller to replay the update.
        return this.lease.current() === null ? "accepted" : "maintenance";
      }

      let text = channelErrorText(ownerLocale(this.env));
      try {
        const task = this.env.TASK.get(
          this.env.TASK.idFromName(event.taskId),
        );
        text = await task.handleAction(event, ownerPrincipal());
      } catch (error) {
        console.error(`channel: action failed: ${errorMessage(error)}`);
      }

      try {
        await adapter.answerAction(event.actionId, text);
      } catch (error) {
        console.error(
          `channel: answer callback failed: ${errorMessage(error)}`,
        );
      }
    } catch (error) {
      // The update must always be acknowledged, even for an unexpected bug.
      console.error(`channel: telegram update failed: ${errorMessage(error)}`);
    }
    return "accepted";
  }

  /**
   * Lease RPCs. A live lease pauses inbound webhooks, polling and alarms; the
   * admin gateway keeps it alive on both this hub and the Butler.
   */
  async acquireMaintenance(
    op: Lease["op"],
    opId: string,
  ): Promise<Lease | "busy"> {
    return this.lease.acquire(op, opId);
  }

  async renewMaintenance(opId: string): Promise<boolean> {
    return this.lease.renew(opId);
  }

  async releaseMaintenance(opId: string): Promise<void> {
    this.lease.release(opId);
  }

  async maintenanceActive(): Promise<boolean> {
    return this.lease.current() !== null;
  }

  /**
   * Member ACL boundary used by the server on behalf of a tool caller. The
   * actor comes from trusted code; task ownership comes from the Butler's task
   * index over RPC, never from a model-supplied owner.
   */
  async resolveMemberAttachment(
    actor: Principal,
    key: string,
  ): Promise<string> {
    return this.accessClient().resolveMemberAttachment(actor, key);
  }

  async registerTaskArtifact(
    actor: Principal,
    taskId: string,
    key: string,
  ): Promise<void> {
    return this.accessClient().registerTaskArtifact(actor, taskId, key);
  }

  // ---------------------------------------------------------------------------
  // Sharing (Task 9). Both the owner's Butler and a member's Butler call these
  // with an actor built by trusted code; the label is resolved here, and the
  // attachments are only ever the sender's own ACL rows.
  // ---------------------------------------------------------------------------

  async prepareShare(
    actor: Principal,
    recipientLabel: string,
    text: string,
    attachmentKeys: string[],
  ): Promise<SharePreview> {
    return this.shares().prepareByLabel(
      actor,
      recipientLabel,
      text,
      attachmentKeys,
    );
  }

  async confirmShare(actor: Principal, shareId: string): Promise<ShareResult> {
    return this.shares().confirm(actor, shareId);
  }

  async cancelShare(actor: Principal, shareId: string): Promise<boolean> {
    return this.shares().cancel(actor, shareId);
  }

  /**
   * Sharing reads and writes the same artifact store the channels use, and
   * delivers through this object's own member send paths: a member copy is
   * sent on that member's connection and credential only.
   */
  private shares(): ShareService {
    this.shareServiceCache ??= new ShareService({
      sql: this.db,
      members: this.members,
      access: this.attachments,
      read: async (key) => {
        const object = await artifactStore(this.env).get(key);
        if (!object) return null;
        return {
          bytes: new Uint8Array(await object.arrayBuffer()),
          mime:
            object.httpMetadata?.contentType ?? "application/octet-stream",
        };
      },
      write: async (key, bytes, mime) => {
        await artifactStore(this.env).put(key, bytes, {
          httpMetadata: { contentType: mime },
        });
      },
      deliver: {
        text: async (actor, text) => {
          await this.sendToMember(actor, { text });
        },
        file: async (actor, key) => {
          await this.sendArtifactToMember(actor, key);
        },
      },
    });
    return this.shareServiceCache;
  }

  private accessClient(): MemberAccessClient {
    this.accessClientCache ??= new MemberAccessClient(
      this.members,
      this.attachments,
      async (taskId) => {
        const butler = this.env.BUTLER.get(
          this.env.BUTLER.idFromName("owner"),
        );
        return (await butler.memberTaskScope(taskId)) ?? null;
      },
    );
    return this.accessClientCache;
  }

  // ---------------------------------------------------------------------------
  // Member runtime (Task 4B): authoritative internal RPC.
  //
  // The actor is always built by trusted code, never by a model argument, and
  // is re-read from the directory on every call. Each route is recomputed from
  // the connection's live generation and credential hash, so the cached owner
  // `routePromise` is never reused for a member. No member path falls back to
  // the owner credential, the owner address book or the owner's Butler.
  // ---------------------------------------------------------------------------

  /** Liveness gate: stored role, status and epoch, checked at call time. */
  async assertMemberActive(actor: Principal): Promise<void> {
    this.members.assertActive(actor);
  }

  async memberPrincipal(memberId: string): Promise<Principal | null> {
    return this.members.principal(memberId);
  }

  /** Every non-owner member id, revoked members included. Never a secret. */
  async memberIds(): Promise<string[]> {
    return this.members
      .list()
      .filter((member) => member.role === "member")
      .map((member) => member.memberId);
  }

  /** The whole directory; only a proven owner may read it. */
  async listMembers(actor: Principal): Promise<MemberView[]> {
    this.assertOwnerActor(actor);
    return this.members.list();
  }

  /**
   * Owner gate for the management surface: the claimed role must be the
   * owner's id and role, and the directory must still agree on the epoch.
   */
  /** Writes are refused while a backup/restore owns the database. */
  private async assertWritable(): Promise<void> {
    if (await this.maintenanceActive()) {
      throw new MemberError("MAINTENANCE_ACTIVE");
    }
  }

  private assertOwnerActor(actor: Principal): void {
    if (actor.memberId !== OWNER_ID || actor.role !== "owner") {
      throw new MemberError(MEMBER_ACCESS_DENIED);
    }
    this.members.assertActive(actor);
  }

  /**
   * Owner-only: a fresh member invitation. The token exists in three places
   * only — this return value, the vault and the digest in SQL — and no
   * credential, qrcode or bot token is ever part of the answer.
   */
  async createMemberInvite(
    actor: Principal,
    label: string,
  ): Promise<MemberInviteLink> {
    this.assertOwnerActor(actor);
    await this.assertWritable();
    return await this.issueInvite(label, {});
  }

  /**
   * Owner-only: a replacement invitation for one member. The directory
   * derives the expected userId from the member's live connection, so a
   * different WeChat identity can never inherit the member's history.
   */
  async rebindMember(
    actor: Principal,
    memberId: string,
  ): Promise<MemberInviteLink> {
    this.assertOwnerActor(actor);
    await this.assertWritable();
    const member = this.members.getMember(memberId);
    if (member === null || member.role !== "member") {
      throw new MemberError(MEMBER_ACCESS_DENIED);
    }
    return await this.issueInvite(member.label, {
      kind: "rebind",
      targetMemberId: memberId,
    });
  }

  /** Plan name for the same operation; keeps the fixed contract callable. */
  async createMemberRebind(
    actor: Principal,
    memberId: string,
  ): Promise<MemberInviteLink> {
    return await this.rebindMember(actor, memberId);
  }

  /** Owner-only: invalidates a pending invite and its entry token. */
  async cancelMemberInvite(
    actor: Principal,
    inviteId: string,
  ): Promise<void> {
    this.assertOwnerActor(actor);
    await this.assertWritable();
    if (this.members.getInvite(inviteId) === null) {
      throw new MemberError(INVITE_NOT_FOUND);
    }
    this.members.cancelInvite(inviteId);
    // Stop the login machine and drop its challenge material with the link.
    const login = this.weChatLogin(inviteId, 1);
    await login.load();
    await login.cancel();
    await this.vault.delete(inviteTokenKey(inviteId));
  }

  /**
   * Owner-only: revokes a member and drops the connection's credential from
   * the vault. The rows stay: history, artifacts and audit remain readable,
   * while the epoch bump makes every Principal minted earlier fail closed.
   */
  async revokeMember(actor: Principal, memberId: string): Promise<void> {
    this.assertOwnerActor(actor);
    await this.assertWritable();
    // Read everything the revoke retires before the directory changes: the
    // access epoch is persisted first, so cleanup can never restore access.
    const credentialKey = this.members.credentialKeyOf(memberId);
    const connection = this.members.getConnection(memberId);
    const pendingRebind = this.members
      .listInvites()
      .filter(
        (invite) =>
          invite.kind === "rebind" &&
          invite.targetMemberId === memberId &&
          invite.status === "pending",
      );
    this.members.revoke(memberId);
    // Chat noise stops with the access: nothing queued for this connection is
    // delivered after a revoke, and the login machine cannot resume it.
    for (const invite of pendingRebind) {
      this.members.cancelInvite(invite.inviteId);
      await this.vault.delete(inviteTokenKey(invite.inviteId));
    }
    if (connection !== null) {
      this.memberQueue(connection.connectionId, connection.generation).clear();
      await this.vault.delete(
        contextKey(connection.connectionId, connection.generation),
      );
    }
    if (credentialKey !== null) await this.vault.delete(credentialKey);
  }

  /** Mints the token, records only its digest, then files it in the vault. */
  private async issueInvite(
    label: string,
    options: CreateInviteOptions,
  ): Promise<MemberInviteLink> {
    const token = inviteToken();
    const invite = this.members.createInvite(label, {
      ...options,
      tokenHash: await sha256Hex(token),
    });
    try {
      await this.vault.put(inviteTokenKey(invite.inviteId), token);
    } catch (error) {
      // No link means nothing can ever present this invite: retire it instead
      // of leaving a pending row whose token nobody holds.
      this.members.cancelInvite(invite.inviteId);
      throw error;
    }
    // The invite is usable only once its login driver is armed; an expired or
    // cancelled invite stops that driver at its next step.
    await this.schedule(0, "pollMemberLogin", {
      inviteId: invite.inviteId,
      generation: 1,
    });
    return {
      inviteId: invite.inviteId,
      expiresAt: invite.expiresAt,
      bindUrl: memberBindUrl(this.env.PUBLIC_BASE_URL, token),
    };
  }

  /**
   * The invite's login state machine, driven by the scheduler instead of the
   * page: a closed browser must not strand an invite mid-flow.
   */
  async pollMemberLogin(payload: {
    inviteId: string;
    generation: number;
  }): Promise<void> {
    const invite = this.members.getInvite(payload.inviteId);
    if (invite === null || invite.status !== "pending") return;
    const remaining = invite.expiresAt - Date.now();
    if (remaining <= 0) return;
    if (this.lease.current() !== null) {
      // A maintenance window replaces the database. The invite keeps its own
      // deadline and is resumed when the lease clears, never dropped.
      await this.schedule(
        Math.min(30, Math.max(5, Math.ceil(remaining / 1000))),
        "pollMemberLogin",
        payload,
        { idempotent: true },
      );
      return;
    }
    try {
      await this.pollMemberLoginStep(payload);
    } catch {
      // The payload never enters the log; the schedule keeps the invite alive.
      console.error("channel: member login step failed");
      await this.schedule(5, "pollMemberLogin", payload, { idempotent: true });
    }
  }

  /** One scheduled step per invite; the caller owns lease and retry policy. */
  private async pollMemberLoginStep(payload: {
    inviteId: string;
    generation: number;
  }): Promise<void> {
    const login = this.weChatLogin(payload.inviteId, payload.generation);
    await login.load();
    const stage = login.view().stage;
    if (stage === "idle") await login.startOtherOwner();
    else if (stage === "realname" || stage === "scan") await login.advance();
    const next = login.view().stage;
    if (next === "confirmed" || next === "failed" || next === "denied") {
      await this.vault.delete(inviteTokenKey(payload.inviteId));
      return;
    }
    if (next === "expired" || next === "cancelled") return;
    if (next === "saving") {
      await this.schedule(2, "pollMemberLogin", payload);
      return;
    }
    if (this.members.getInvite(payload.inviteId)?.status !== "pending") return;
    if (Date.now() >= login.view().expiresAt) return;
    await this.schedule(2, "pollMemberLogin", payload);
  }

  /**
   * One login state machine bound to this DO's storage. Credentials only leave
   * it through `onConfirmed`, which activates the invite's connection.
   */
  private weChatLogin(inviteId: string, generation: number): WeChatLogin {
    const invite = this.members.getInvite(inviteId);
    const expiresAt = invite?.expiresAt ?? Date.now();
    const store = this.members;
    return new WeChatLogin({
      inviteId,
      generation,
      expiresAt,
      state: new SqlLoginStateStore(this.db),
      secrets: new VaultLoginSecretStore(this.ctx.storage),
      transport: createILinkClient({
        fetch: getILinkFetchOverride() ?? undefined,
      }),
      inviteLive: async () => {
        const current = store.getInvite(inviteId);
        return (
          current !== null &&
          current.status === "pending" &&
          Date.now() < current.expiresAt
        );
      },
      activationStatus: async () =>
        store.getInvite(inviteId)?.status === "consumed"
          ? "committed"
          : "pending",
      onConfirmed: async (credentials: WeChatCredentials) => {
        const raw = JSON.stringify(credentials);
        const binding = {
          connectionId: inviteId,
          accountId: credentials.accountId,
          userId: credentials.userId,
          credentialHash: await sha256Hex(raw),
        };
        await stageCredentialAndActivate(
          this.staging,
          `credential-${inviteId}`,
          raw,
          (credentialKey) =>
            this.members.completeInvite(inviteId, {
              ...binding,
              credentialKey,
            }),
        );
      },
    });
  }

  /** Resolves the invite by bearer token; wrong or expired tokens are 401/410. */
  private async inviteByToken(
    token: string,
  ): Promise<
    { ok: true; inviteId: string } | { ok: false; status: 401 | 410 }
  > {
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return { ok: false, status: 401 };
    const invite = this.members.findInviteByTokenHash(await sha256Hex(token));
    if (invite === null) return { ok: false, status: 401 };
    if (invite.status !== "pending" || Date.now() >= invite.expiresAt) {
      return { ok: false, status: 410 };
    }
    return { ok: true, inviteId: invite.inviteId };
  }

  /** The page's read-only view: no ticket, no token, no bot credential. */
  async memberBindState(
    token: string,
  ): Promise<
    | { ok: true; view: import("./wechat/login").InviteView }
    | { ok: false; status: 401 | 403 | 404 | 410 }
  > {
    const found = await this.inviteByToken(token);
    if (!found.ok) return found;
    const login = this.weChatLogin(found.inviteId, 1);
    await login.load();
    return { ok: true, view: login.view() };
  }

  /** PIN submission runs the poll in this request; the PIN is never stored. */
  async submitMemberBindPin(
    token: string,
    pin: string,
  ): Promise<
    | { ok: true; view: import("./wechat/login").InviteView }
    | { ok: false; status: 401 | 403 | 404 | 410 }
  > {
    const found = await this.inviteByToken(token);
    if (!found.ok) return found;
    if (!this.consumePinAttempt(found.inviteId)) {
      return { ok: true, view: this.weChatLogin(found.inviteId, 1).view() };
    }
    const login = this.weChatLogin(found.inviteId, 1);
    await login.load();
    await login.submitPin(pin);
    return { ok: true, view: login.view() };
  }

  /** Owner-only: pending invites, both kinds, for the desktop console. */
  async adminPendingInvites(): Promise<
    Array<{
      inviteId: string;
      label: string;
      kind: "new" | "rebind";
      memberId: string | null;
      expiresAt: number;
    }>
  > {
    this.assertOwnerActor(ownerPrincipal());
    const now = Date.now();
    return this.members
      .listInvites()
      .filter((invite) => invite.status === "pending" && now < invite.expiresAt)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((invite) => ({
        inviteId: invite.inviteId,
        label: invite.label,
        kind: invite.kind,
        memberId: invite.memberId,
        expiresAt: invite.expiresAt,
      }));
  }

  /** Owner-only: one invite's stage, without holding its bearer token. */
  async adminInviteState(
    inviteId: string,
  ): Promise<
    | { ok: true; view: AdminInviteView }
    | { ok: false; status: 404 }
  > {
    this.assertOwnerActor(ownerPrincipal());
    const invite = this.members.getInvite(inviteId);
    if (invite === null) return { ok: false, status: 404 };
    const login = this.weChatLogin(inviteId, 1);
    await login.load();
    return { ok: true, view: adminInviteView(invite, login.view(), Date.now()) };
  }

  /** Owner-only: submit the PIN WeChat showed on the invitee's phone. */
  async adminSubmitInvitePin(
    inviteId: string,
    pin: string,
  ): Promise<
    | { ok: true; view: AdminInviteView }
    | { ok: false; status: 400 | 404 | 409 | 429 }
  > {
    this.assertOwnerActor(ownerPrincipal());
    // The PIN path writes attempts, login state and possibly a connection.
    await this.assertWritable();
    if (!/^\d{6}$/.test(pin)) return { ok: false, status: 400 };
    const invite = this.members.getInvite(inviteId);
    if (invite === null) return { ok: false, status: 404 };
    const login = this.weChatLogin(inviteId, 1);
    await login.load();
    if (login.view().stage !== "pin") return { ok: false, status: 409 };
    if (!this.consumePinAttempt(inviteId)) return { ok: false, status: 429 };
    await login.submitPin(pin);
    await login.load();
    return {
      ok: true,
      view: adminInviteView(this.members.getInvite(inviteId)!, login.view(), Date.now()),
    };
  }

  /**
   * A 6-digit PIN is small enough to brute-force by whoever holds the invite,
   * so both the page and the admin surface share one budget per invite. The
   * server-side verify-code block is not the only line of defence.
   */
  private consumePinAttempt(inviteId: string): boolean {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS member_bind_attempts (
         invite_id TEXT PRIMARY KEY,
         attempts INTEGER NOT NULL DEFAULT 0
       )`,
    );
    const attempts =
      this.db
        .exec<{ attempts: number }>(
          `SELECT attempts FROM member_bind_attempts WHERE invite_id = ?`,
          inviteId,
        )
        .toArray()[0]?.attempts ?? 0;
    if (attempts >= 5) return false;
    this.db.exec(
      `INSERT INTO member_bind_attempts (invite_id, attempts) VALUES (?, 1)
       ON CONFLICT(invite_id) DO UPDATE SET attempts = attempts + 1`,
      inviteId,
    );
    return true;
  }

  /**
   * The member's own route. A member route is namespaced by connection and
   * generation under its own domain separator, so it never equals the owner's
   * key and an owner route cached at boot cannot keep a member out.
   */
  async routeForMember(actor: Principal): Promise<RouteSnapshot> {
    this.members.assertActive(actor);
    // Owner compatibility: the owner keeps the deployment-wide route.
    if (actor.memberId === OWNER_ID) return this.currentRoute();

    const connection = this.members.getConnection(actor.memberId);
    if (!connection) throw new MemberError(MEMBER_ACCESS_DENIED);

    const versionId = versionIdOf(this.env.CF_VERSION_METADATA);
    const channel = parseActiveChannel(this.env.ACTIVE_CHANNEL);
    if (versionId === null || channel !== "wechat") {
      // Members are WeChat-only: another selection disables their route
      // instead of lending them the owner's channel.
      return { channel: null, routeKey: DISABLED_ROUTE_KEY };
    }
    return memberRouteIdentity({
      versionId,
      channel,
      connectionId: connection.connectionId,
      generation: connection.generation,
      credentialHash: connection.credentialHash,
    });
  }

  /**
   * Full admission for one inbound or outbound member action: actor liveness,
   * ref ownership, connection id and generation, the directory's live
   * credential hash and the deployment's active channel.
   */
  async isMemberAdmissionCurrent(
    actor: Principal,
    channel: ChannelId,
    ref: ConnectionRef,
    routeKey: string,
  ): Promise<boolean> {
    try {
      this.members.assertActive(actor);
    } catch {
      return false;
    }
    if (channel !== "wechat") return false;
    // A ref that names another member is never admitted, even when that
    // member's connection and key would otherwise check out.
    if (ref.memberId !== actor.memberId) return false;

    const connection = this.members.getConnection(actor.memberId);
    if (!connection) return false;
    if (connection.connectionId !== ref.connectionId) return false;
    if (connection.generation !== ref.generation) return false;

    let route: RouteSnapshot;
    try {
      route = await this.routeForMember(actor);
    } catch {
      return false;
    }
    return route.channel === channel && route.routeKey === routeKey;
  }

  /**
   * Sends to the member's own connection only. The queue is scoped by
   * connection and generation, so A's backlog, retries and failures never
   * touch B's.
   */
  async sendToMember(
    actor: Principal,
    message: OutboundMessage,
  ): Promise<ChannelMessageRef> {
    this.members.assertActive(actor);
    // Owner compatibility: the legacy path is unchanged for the owner actor.
    if (actor.memberId === OWNER_ID) return this.sendCurrent(message);

    const connection = this.members.getConnection(actor.memberId);
    if (!connection) throw new MemberError(MEMBER_ACCESS_DENIED);
    const ref: ConnectionRef = {
      memberId: connection.memberId,
      connectionId: connection.connectionId,
      generation: connection.generation,
    };
    const route = await this.routeForMember(actor);
    if (route.channel !== "wechat") {
      throw new ChannelError("channel selection disabled", 0);
    }
    // Re-verified after the awaits above: a revoke or rebind in between must
    // stop the send instead of queueing to a replaced connection.
    if (!(await this.isMemberAdmissionCurrent(actor, "wechat", ref, route.routeKey))) {
      throw new MemberError(MEMBER_ACCESS_DENIED);
    }

    const state = this.connections.read(connection.connectionId);
    const conversationId = state?.conversationId ?? "";
    const outbound = forWechat(message, ownerLocale(this.env));
    const { dropped } = this.memberQueue(
      connection.connectionId,
      connection.generation,
    ).enqueue({
      conversationId,
      text: outbound.text,
      buttons: outbound.buttons ?? null,
      priority: message.priority,
    });
    if (dropped > 0) {
      console.error(
        `channel: member outbound queue dropped ${dropped} oldest rows`,
      );
    }

    await this.flushMemberOutbound(
      connection.connectionId,
      connection.generation,
    );
    return {
      channel: "wechat",
      conversationId,
      routeKey: route.routeKey,
      messageId: null,
    };
  }

  /** Sends an artifact to the member's own conversation and credential only. */
  async sendArtifactToMember(actor: Principal, key: string): Promise<void> {
    this.members.assertActive(actor);
    if (actor.memberId === OWNER_ID) return this.sendArtifact(key);

    if (artifactKeySegments(key) === null) {
      throw new ChannelError("invalid artifact key", 400);
    }
    const connection = this.members.getConnection(actor.memberId);
    if (!connection) throw new MemberError(MEMBER_ACCESS_DENIED);
    const ref: ConnectionRef = {
      memberId: connection.memberId,
      connectionId: connection.connectionId,
      generation: connection.generation,
    };
    const route = await this.routeForMember(actor);
    if (route.channel !== "wechat") {
      throw new ChannelError("channel selection disabled", 0);
    }

    const object = await artifactStore(this.env).get(key);
    if (!object) throw new ChannelError("artifact missing", 404);
    if (object.size > MAX_ARTIFACT_BYTES) {
      throw new ChannelError("artifact too large", 413);
    }
    const file: OutboundArtifact = {
      name: artifactNameFromKey(key),
      contentType:
        object.httpMetadata?.contentType ?? "application/octet-stream",
      bytes: await object.arrayBuffer(),
    };

    // The copy above is the last await before the network call, so admission
    // is checked again here: a revoke during the download must win.
    if (!(await this.isMemberAdmissionCurrent(actor, "wechat", ref, route.routeKey))) {
      throw new MemberError(MEMBER_ACCESS_DENIED);
    }

    const credentials = await this.loadMemberCredentials(
      ref.connectionId,
      ref.generation,
    );
    const conversationId =
      this.connections.read(ref.connectionId)?.conversationId ?? "";
    const context = await this.connections.readContext(
      ref.connectionId,
      ref.generation,
    );
    if (!credentials || conversationId === "" || context === null) {
      throw new ChannelError("wechat context missing", 0);
    }
    if (!(await this.isMemberAdmissionCurrent(actor, "wechat", ref, route.routeKey))) {
      throw new MemberError(MEMBER_ACCESS_DENIED);
    }

    try {
      await withRetry(async () => {
        await createILinkClient({
          fetch: getILinkFetchOverride() ?? undefined,
        }).sendMedia(credentials, conversationId, context, file);
      });
      emitChannelEvent(this.env, { channel: "wechat", event: "send_ok" });
    } catch (error) {
      emitChannelEvent(this.env, {
        channel: "wechat",
        event: "send_error",
        errorCode: channelErrorCode(error),
      });
      throw error;
    }
  }

  /**
   * Loads one connection's credential from the private vault. The pointer is
   * read by trusted SQL only, the parsed identity must still match the
   * directory row, and the generation is re-checked after every await.
   */
  private async loadMemberCredentials(
    connectionId: string,
    generation: number,
  ): Promise<WeChatCredentials | null> {
    const row = this.db
      .exec<{
        credential_key: string;
        account_id: string;
        user_id: string;
        credentials_hash: string;
        generation: number;
        status: string;
      }>(
        `SELECT credential_key, account_id, user_id, credentials_hash,
                generation, status
         FROM member_connections WHERE id = ?`,
        connectionId,
      )
      .toArray()[0];
    if (!row || row.status === "retired" || row.generation !== generation) {
      return null;
    }

    const stored = await this.vault.get<unknown>(row.credential_key);
    const raw =
      typeof stored === "string"
        ? stored
        : stored === undefined
          ? null
          : JSON.stringify(stored);
    if (raw === null) return null;

    const credentials = parseCredentials(raw);
    if (!credentials) return null;
    // The stored identity is the authority: a credential for someone else is
    // never admitted for this connection.
    if (
      credentials.accountId !== row.account_id ||
      credentials.userId !== row.user_id
    ) {
      return null;
    }
    if ((await credentialsHash(raw)) !== row.credentials_hash) return null;
    // A rebind may have completed while the vault was reading.
    if (this.connections.read(connectionId)?.generation !== generation) {
      return null;
    }
    return credentials;
  }

  /**
   * One bounded poll step for one member connection. The payload names the
   * connection and generation, so a callback from a replaced credential can
   * neither read nor advance its successor's cursor.
   */
  async pollMemberWeChat(
    payload?: unknown,
    _schedule?: Schedule<unknown>,
  ): Promise<void> {
    if (this.lease.current() !== null) return;
    const target = connectionPayload(payload);
    if (target === null) return;
    if (parseActiveChannel(this.env.ACTIVE_CHANNEL) !== "wechat") return;

    const state = this.connections.read(target.connectionId);
    if (
      state === null ||
      state.status !== "active" ||
      state.generation !== target.generation ||
      // The owner connection has its own chain, keyed by the deployed secret.
      state.memberId === OWNER_ID
    ) {
      return;
    }
    if (this.activeMemberWeChatRuns.has(target.connectionId)) return;

    const actor = this.members.principal(state.memberId);
    if (actor === null || actor.role !== "member") return;
    const ref: ConnectionRef = {
      memberId: state.memberId,
      connectionId: state.connectionId,
      generation: state.generation,
    };

    let route: RouteSnapshot;
    let credentials: WeChatCredentials | null;
    try {
      route = await this.routeForMember(actor);
      credentials = await this.loadMemberCredentials(
        ref.connectionId,
        ref.generation,
      );
    } catch (error) {
      console.warn(`channel: member poll skipped: ${errorMessage(error)}`);
      return;
    }
    if (route.channel !== "wechat" || credentials === null) return;

    const run = { generation: ref.generation };
    this.activeMemberWeChatRuns.set(ref.connectionId, run);
    const ownsRun = async () => {
      const current = this.connections.read(ref.connectionId);
      return (
        this.activeMemberWeChatRuns.get(ref.connectionId) === run &&
        this.lease.current() === null &&
        current !== null &&
        current.status === "active" &&
        current.generation === ref.generation &&
        (await this.isMemberAdmissionCurrent(
          actor,
          "wechat",
          ref,
          route.routeKey,
        ))
      );
    };

    try {
      const timing = getPollTimingOverride() ?? {
        runMs: WECHAT_POLL_RUN_MS,
        baseBackoffMs: WECHAT_POLL_BACKOFF_MS,
      };
      const client = createILinkClient({
        fetch: getILinkFetchOverride() ?? undefined,
      });
      // Heartbeat before the long poll, so ensurePolling does not mistake a
      // live chain for a dead one and start a second.
      this.connections.update(
        ref.connectionId,
        { lastPollAt: Date.now(), pollStatus: "polling" },
        ref.generation,
      );

      let batch: { cursor: string; updates: WeChatUpdate[] };
      try {
        // Exactly one bounded getUpdates per callback: the next alarm
        // continues the chain, so a deploy never leaves a long call running.
        batch = await client.getUpdates(
          credentials,
          this.memberCursor(ref.connectionId, ref.generation),
          AbortSignal.timeout(WECHAT_GET_UPDATES_TIMEOUT_MS),
        );
      } catch (error) {
        if (!(await ownsRun())) return;
        if (isSessionExpired(error)) {
          emitChannelEvent(this.env, {
            channel: "wechat",
            event: "poll_expired",
            errorCode: "session_expired",
          });
          // This connection only: the deployment's owner state is untouched.
          this.connections.update(
            ref.connectionId,
            { pollStatus: "expired", expiryNotified: true, lastPollAt: Date.now() },
            ref.generation,
          );
          console.warn("channel: member wechat session expired");
          return;
        }
        emitChannelEvent(this.env, {
          channel: "wechat",
          event: "poll_error",
          errorCode: channelErrorCode(error),
        });
        console.error(
          `channel: member wechat poll failed: ${errorMessage(error)}`,
        );
        const backoffMs =
          this.memberWeChatBackoffMs.get(ref.connectionId) ??
          timing.baseBackoffMs;
        await sleep(backoffMs);
        this.memberWeChatBackoffMs.set(
          ref.connectionId,
          Math.min(backoffMs * 2, WECHAT_POLL_MAX_BACKOFF_MS),
        );
        await this.scheduleMemberPoll(ref);
        return;
      }

      if (!(await ownsRun())) return;
      emitChannelEvent(this.env, { channel: "wechat", event: "poll_ok" });
      this.connections.update(
        ref.connectionId,
        { lastPollAt: Date.now() },
        ref.generation,
      );

      const outcome = await this.dispatchMemberWeChatUpdates(
        credentials,
        batch,
        ref,
        actor,
        route.routeKey,
      );
      if (outcome === "maintenance") return;
      // Cursor last: a crash mid-batch makes iLink resend it rather than lose
      // everything this connection already received.
      this.updateMemberCursor(ref.connectionId, ref.generation, batch.cursor);
      this.memberWeChatBackoffMs.delete(ref.connectionId);
      if (!(await ownsRun())) return;
      await this.scheduleMemberPoll(ref);
    } finally {
      if (this.activeMemberWeChatRuns.get(ref.connectionId) === run) {
        this.activeMemberWeChatRuns.delete(ref.connectionId);
      }
    }
  }

  private async scheduleMemberPoll(ref: ConnectionRef): Promise<void> {
    // Tests drive pollMemberWeChat explicitly. Scheduling here would start a
    // live chain that fires before the test installs its scripted fetch.
    if (getPollTimingOverride()?.manualStart) return;
    await this.schedule(
      0,
      "pollMemberWeChat",
      { connectionId: ref.connectionId, generation: ref.generation },
      { idempotent: true },
    );
  }

  /** Schedules every live member connection that has no pending poll. */
  private async startMemberWeChatPolling(): Promise<void> {
    if (getPollTimingOverride()?.manualStart) return;
    const now = Date.now();
    const pending = await this.listSchedules();

    for (const connection of this.connections.listActive()) {
      if (connection.memberId === OWNER_ID) continue;
      if (
        connection.lastPollAt !== null &&
        now - connection.lastPollAt < WECHAT_HEARTBEAT_MAX_AGE_MS
      ) {
        continue;
      }
      const scheduled = pending.some(
        (schedule) =>
          schedule.callback === "pollMemberWeChat" &&
          connectionPayload(schedule.payload)?.connectionId ===
            connection.connectionId,
      );
      if (scheduled) continue;
      await this.schedule(
        0,
        "pollMemberWeChat",
        { connectionId: connection.connectionId, generation: connection.generation },
        { idempotent: true },
      );
    }
  }

  /** Stops every member chain without touching the owner chain or cursors. */
  private async stopMemberWeChatPolling(): Promise<void> {
    this.activeMemberWeChatRuns.clear();
    for (const schedule of await this.listSchedules()) {
      if (schedule.callback === "pollMemberWeChat") {
        await this.cancelSchedule(schedule.id);
      }
    }
  }

  private dispatchMemberWeChatUpdates(
    credentials: WeChatCredentials,
    batch: { cursor: string; updates: WeChatUpdate[] },
    ref: ConnectionRef,
    actor: Principal,
    routeKey: string,
  ): Promise<"accepted" | "maintenance"> {
    return (async () => {
      // A lease can land while getUpdates is in flight: do not admit the batch
      // or write connection state into a database that is being restored.
      if (this.lease.current() !== null) return "maintenance" as const;

      for (let index = 0; index < batch.updates.length; index += 1) {
        const update = batch.updates[index];
        if (update.messageType !== 1) continue;
        // Only this account's own messages are admitted: the sender id comes
        // from the credential, never from the message body.
        if (update.fromUserId !== credentials.userId) continue;

        // The connection id is generated here and namespaced per connection,
        // so two members' identical message ids never collide.
        const eventId = `wx:${ref.connectionId}:${
          update.messageId ?? `${batch.cursor}:${index}`
        }`;

        if (!(await this.isMemberAdmissionCurrent(actor, "wechat", ref, routeKey))) {
          return "accepted" as const;
        }

        if (update.contextToken) {
          // The token goes to the vault, keyed by connection and generation.
          const written = await this.connections.writeContext(
            ref.connectionId,
            ref.generation,
            update.contextToken,
          );
          if (written) {
            this.ctx.waitUntil(
              this.flushMemberOutbound(ref.connectionId, ref.generation).catch(
                (error: unknown) => {
                  console.error(
                    `channel: member outbound flush failed: ${errorMessage(error)}`,
                  );
                },
              ),
            );
          }
        }

        // A member's conversation is its own row; the owner address book is
        // written only by proven owner ingress.
        this.connections.setConversation(ref.connectionId, update.fromUserId);

        const event: MessageEvent = {
          type: "message",
          channel: "wechat",
          chatId: update.fromUserId,
          userId: update.fromUserId,
          text: update.text,
          ...(update.quotedText ? { quotedText: update.quotedText } : {}),
          ...(update.voice && !update.text ? { voiceFailed: true } : {}),
          eventId,
        };

        if (update.media.length > 0) {
          // 一条消息可以带多个图片或文件，每个 item 单独下发。文字只跟第一个
          // item 走，其余 item 只带附件，与主人路径一致。存储与派发都在这个
          // 成员的受信上下文里进行：附件归属成员的 member id，事件 id 也在
          // 连接命名空间内，A 的字节永远到不了 B 或主人。
          const trust: MediaTrust = { actor, ref };
          for (let i = 0; i < update.media.length; i += 1) {
            const item = update.media[i];
            const itemEvent: MessageEvent = {
              ...event,
              ...(i === 0 ? {} : { text: null }),
              eventId: update.media.length === 1 ? eventId : `${eventId}:${i}`,
            };
            // The previous item's download may have spanned a revoke or a
            // rebind: re-admit before touching the next one.
            if (!(await this.isMemberAdmissionCurrent(actor, "wechat", ref, routeKey))) {
              return "accepted" as const;
            }
            if (item.kind === "image") {
              await this.dispatchWeChatImage(
                itemEvent,
                item.image,
                routeKey,
                trust,
              );
            } else {
              await this.dispatchWeChatFile(
                itemEvent,
                item.file,
                routeKey,
                trust,
              );
            }
          }
          continue;
        }

        // A member's text command is resolved by the member's own Butler and
        // answered on the member's own connection; anything that is not a
        // command stays an ordinary message.
        const shareCommand =
          update.text === null ? null : parseShareCommand(update.text);
        if (shareCommand !== null) {
          await this.handleMemberShareCommand(
            shareCommand,
            actor,
            ref,
            routeKey,
          );
          continue;
        }
        if (update.text !== null && parseTextAction(update.text) !== null) {
          const handled = await this.handleMemberTextAction(
            event,
            eventId,
            routeKey,
            actor,
            ref,
          );
          if (handled) continue;
        }
        this.dispatchMessage(event, routeKey, { actor, ref });
      }
      return "accepted" as const;
    })();
  }

  /**
   * One member text command (批准/拒绝/取消). The resolver, the task index and
   * the answer all belong to the sending member: an explicit task id from
   * another member's namespace never reaches its Task DO.
   */
  /**
   * A member's own `确认分享 shN` / `取消分享 shN`. The share row is looked up
   * against the sending member, so one member can never confirm or cancel
   * another member's share; the answer goes to the same connection.
   */
  private async handleMemberShareCommand(
    command: ShareCommand,
    actor: Principal,
    ref: ConnectionRef,
    routeKey: string,
  ): Promise<void> {
    if (!(await this.isMemberAdmissionCurrent(actor, "wechat", ref, routeKey))) {
      return;
    }
    const text = await this.shareReplyText(actor, command);
    if (!(await this.isMemberAdmissionCurrent(actor, "wechat", ref, routeKey))) {
      return;
    }
    await this.sendToMember(actor, { text });
  }

  /** Runs one share command for its own sender and returns the reply copy. */
  private async shareReplyText(
    actor: Principal,
    command: ShareCommand,
  ): Promise<string> {
    const locale = ownerLocale(this.env);
    try {
      if (command.action === "confirm") {
        const result = await this.confirmShare(actor, command.shareId);
        return t(locale, "member.share.confirmed", {
          shareId: result.shareId,
          count: result.delivered,
        });
      }
      const cancelled = await this.cancelShare(actor, command.shareId);
      return cancelled
        ? t(locale, "member.share.cancelled", { shareId: command.shareId })
        : t(locale, "member.share.notFound");
    } catch (error) {
      return shareErrorText(locale, error);
    }
  }

  private async handleMemberTextAction(
    event: MessageEvent,
    eventId: string,
    routeKey: string,
    actor: Principal,
    ref: ConnectionRef,
  ): Promise<boolean> {
    const parsed = event.text === null ? null : parseTextAction(event.text);
    if (parsed === null) return false;
    const deny = async (text: string): Promise<boolean> => {
      if (await this.isMemberAdmissionCurrent(actor, "wechat", ref, routeKey)) {
        await this.sendToMember(actor, { text });
      }
      return true;
    };
    if (!(await this.isMemberAdmissionCurrent(actor, "wechat", ref, routeKey))) {
      return true;
    }
    const butler = this.env.BUTLER.get(
      this.env.BUTLER.idFromName(butlerName(actor.memberId)),
    ) as unknown as Partial<MemberButlerRpc>;
    if (
      typeof butler.resolveTextAction !== "function" ||
      typeof butler.hasTask !== "function"
    ) {
      return deny(channelErrorText(ownerLocale(this.env)));
    }

    let target: { taskId: string; label: string; approvalId?: string } | null = null;
    if (parsed.target.kind === "taskId" || parsed.target.kind === "handle") {
      try {
        const resolution = await butler.resolveTextAction(parsed, actor);
        if (resolution.kind === "chat") return false;
        if (resolution.kind === "reply") return deny(resolution.text);
        target = {
          taskId: resolution.taskId,
          label: resolution.label,
          ...(resolution.approvalId === undefined
            ? {}
            : { approvalId: resolution.approvalId }),
        };
      } catch (error) {
        console.error(
          `channel: member action resolution failed: ${errorMessage(error)}`,
        );
        return deny(channelErrorText(ownerLocale(this.env)));
      }
    }

    if (target === null) {
      // An implicit target is one of the member's own active tasks.
      try {
        const resolution = await butler.resolveTextAction(parsed, actor);
        if (resolution.kind === "chat") return false;
        if (resolution.kind === "reply") return deny(resolution.text);
        target = {
          taskId: resolution.taskId,
          label: resolution.label,
          ...(resolution.approvalId === undefined
            ? {}
            : { approvalId: resolution.approvalId }),
        };
      } catch (error) {
        console.error(
          `channel: member action resolution failed: ${errorMessage(error)}`,
        );
        return deny(channelErrorText(ownerLocale(this.env)));
      }
    }

    if (!(await butler.hasTask(target.taskId, actor))) {
      return deny(t(ownerLocale(this.env), "task.control.denied"));
    }

    const action: ActionEvent = {
      type: "action",
      channel: "wechat",
      chatId: event.chatId,
      userId: event.userId,
      actionId: eventId,
      messageId: eventId,
      action: parsed.action,
      taskId: target.taskId,
      ...(target.approvalId === undefined
        ? {}
        : { approvalId: target.approvalId }),
      eventId,
    };
    let text = channelErrorText(ownerLocale(this.env));
    try {
      const task = this.env.TASK.get(this.env.TASK.idFromName(action.taskId));
      text = await task.handleAction(action, actor);
      if (target.label !== target.taskId) {
        text = replaceTaskId(text, target.taskId, target.label);
      }
    } catch (error) {
      console.error(`channel: member action failed: ${errorMessage(error)}`);
    }
    return deny(text);
  }

  private updateMemberCursor(
    connectionId: string,
    generation: number,
    cursor: string,
  ): void {
    this.db.exec(
      `UPDATE member_connections SET cursor = ?
       WHERE id = ? AND generation = ? AND status <> 'retired'`,
      cursor,
      connectionId,
      generation,
    );
  }

  /** The connection's own cursor; never the deployment-wide owner cursor. */
  private memberCursor(connectionId: string, generation: number): string {
    return (
      this.db
        .exec<{ cursor: string }>(
          `SELECT cursor FROM member_connections
           WHERE id = ? AND generation = ? AND status <> 'retired'`,
          connectionId,
          generation,
        )
        .toArray()[0]?.cursor ?? ""
    );
  }

  private memberQueue(
    connectionId: string,
    generation: number,
  ): OutboundQueue {
    const cached = this.memberQueues.get(connectionId);
    if (cached !== undefined && cached.generation === generation) {
      return cached.queue;
    }
    const queue = new OutboundQueue(this.db, { connectionId, generation });
    this.memberQueues.set(connectionId, { generation, queue });
    return queue;
  }

  /** Single-flight per connection; A's drain never waits on B's. */
  private async flushMemberOutbound(
    connectionId: string,
    generation: number,
  ): Promise<void> {
    const key = `${connectionId}:${generation}`;
    const running = this.memberOutboundFlush.get(key);
    if (running !== undefined) {
      // A row may be added while the running drain lists them: ask for one
      // more pass instead of leaving it for the next caller.
      this.memberOutboundAgain.add(key);
      await running;
      return;
    }
    const flush = this.drainMemberOutbound(connectionId, generation).finally(
      () => {
        this.memberOutboundFlush.delete(key);
      },
    );
    this.memberOutboundFlush.set(key, flush);
    await flush;
    if (this.memberOutboundAgain.delete(key)) {
      await this.flushMemberOutbound(connectionId, generation);
    }
  }

  /**
   * Drains one connection's queue. Only rows this connection owns are read, so
   * another connection's backlog, retries and failures are invisible here.
   */
  private async drainMemberOutbound(
    connectionId: string,
    generation: number,
  ): Promise<void> {
    const queue = this.memberQueue(connectionId, generation);
    const state = this.connections.read(connectionId);
    if (
      state === null ||
      state.status !== "active" ||
      state.generation !== generation
    ) {
      return;
    }
    // No address yet: the rows wait for the member's first inbound message.
    if (state.conversationId === "") return;

    const actor = this.members.principal(state.memberId);
    if (actor === null || actor.role !== "member") return;
    const ref: ConnectionRef = {
      memberId: state.memberId,
      connectionId,
      generation,
    };

    let route: RouteSnapshot;
    try {
      route = await this.routeForMember(actor);
    } catch {
      return;
    }
    if (route.channel !== "wechat") return;

    const credentials = await this.loadMemberCredentials(connectionId, generation);
    if (credentials === null) return;
    const context = await this.connections.readContext(connectionId, generation);
    if (context === null) return;

    const client = createILinkClient({
      fetch: getILinkFetchOverride() ?? undefined,
    });

    for (const row of queue.listCurrent()) {
      // A row written for a replaced credential can never be delivered.
      if (row.generation !== generation) {
        queue.remove(row.id);
        continue;
      }
      const current = this.connections.read(connectionId);
      if (current === null || current.conversationId === "") return;
      if (row.conversationId !== current.conversationId) {
        queue.remove(row.id);
        console.error("channel: dropped a queued message for a former account");
        continue;
      }
      if (row.attempts >= OUTBOUND_MAX_ATTEMPTS) {
        queue.remove(row.id);
        console.error(
          `channel: gave up on a queued message after ${row.attempts} attempts`,
        );
        emitChannelEvent(this.env, {
          channel: "wechat",
          event: "send_error",
          errorCode: row.lastError ?? "api_error",
        });
        continue;
      }
      // Re-checked immediately before every actual send: the actor may have
      // been revoked or the connection rebound during the copy above.
      if (
        !(await this.isMemberAdmissionCurrent(
          actor,
          "wechat",
          ref,
          route.routeKey,
        ))
      ) {
        return;
      }
      try {
        await client.sendText(
          credentials,
          current.conversationId,
          context,
          row.text,
        );
        queue.remove(row.id);
      } catch (error) {
        // Order matters: later messages wait behind this one, and this failure
        // ends only this connection's drain.
        const code = channelErrorCode(error);
        queue.markError(row.id, code);
        emitChannelEvent(this.env, {
          channel: "wechat",
          event: "send_error",
          errorCode: code,
        });
        console.error(`channel: member send failed: ${errorMessage(error)}`);
        return;
      }
    }
  }

  private registerInboundFiles(event: MessageEvent, memberId: string): void {
    for (const file of event.files ?? []) {
      try {
        this.attachments.record(memberId, file.key);
      } catch (error) {
        console.error(
          `channel: attachment registration failed (${event.eventId}): ` +
            errorMessage(error),
        );
      }
    }
  }

  async ownerStatus(): Promise<OwnerStatus> {
    return ownerStatusOf({
      config: this.ownerConfig(),
      // 读状态不启动窗口（read 是纯的）；开窗只发生在 DO 启动、收到消息或显式 open。
      claim:
        this.ownerConfig().telegramUserIds === undefined
          ? this.owners.read()
          : { ownerUserId: null, windowOpenedAt: 0 },
      now: Date.now(),
    });
  }

  async openOwnerClaim(): Promise<OwnerStatus> {
    // 名单来自 env，运行时无权改；静默返回现状而不是写一行认领记录。
    if (this.ownerConfig().telegramUserIds !== undefined) {
      return this.ownerStatus();
    }
    this.owners.openWindow();
    return this.ownerStatus();
  }

  async revokeOwner(): Promise<OwnerStatus> {
    if (this.ownerConfig().telegramUserIds !== undefined) {
      return this.ownerStatus();
    }
    this.owners.revoke();
    return this.ownerStatus();
  }

  async backupSchema(): Promise<DbSchema> {
    return this.backup.backupSchema();
  }

  async backupPage(
    table: TableSchema,
    cursor: string | null,
  ): Promise<DumpPage> {
    return this.backup.backupPage(table, cursor);
  }

  async restoreBegin(schema: DbSchema): Promise<void> {
    await this.backup.restoreBegin(schema);
  }

  async restorePage(table: TableSchema, rows: DumpRow[]): Promise<void> {
    await this.backup.restorePage(table, rows);
  }

  async restoreCommit(schema: DbSchema): Promise<void> {
    await this.backup.restoreCommit(schema);
    await this.resetMemberAccessAfterRestore();
  }

  /**
   * A backup never carries WeChat credentials, so every restored member
   * connection is unbound until its own WeChat account scans a rebind
   * invite again. Pending invites and login challenges from before the
   * restore die with the old deployment; queued chat would otherwise be sent
   * under credentials the archive never contained.
   */
  private async resetMemberAccessAfterRestore(): Promise<void> {
    const keys = await this.ctx.storage.list({
      prefix: PRIVATE_WECHAT_PREFIX,
    });
    if (keys.size > 0) {
      await this.ctx.storage.delete([...keys.keys()]);
    }
    for (const invite of this.members.listInvites()) {
      if (invite.status === "pending") this.members.cancelInvite(invite.inviteId);
    }
    // Restored connections have no credential in this deployment: mark them
    // paused so polling does not re-arm a chain that cannot load one, and so
    // the owner can see a member needs to scan again.
    this.db.exec(
      `UPDATE member_connections
       SET poll_status = 'paused', credential_key = ''
       WHERE member_id <> 'owner'`,
    );
    try {
      this.db.exec(`DELETE FROM wechat_login`);
    } catch {
      // A database restored from an older release has no login rows yet.
    }
    this.db.exec(`DELETE FROM outbound_queue WHERE connection_id <> 'owner'`);
    try {
      this.db.exec(
        `UPDATE member_shares SET status = 'expired'
         WHERE status IN ('pending', 'sending')`,
      );
    } catch {
      // Restored from a release without shares: nothing to invalidate.
    }
  }

  async restoreReset(): Promise<void> {
    this.backup.restoreReset();
  }

  override async alarm(): Promise<void> {
    if (this.lease.current() !== null) {
      await this.ctx.storage.setAlarm(Date.now() + DEFER_MS);
      return;
    }
    await super.alarm();
  }

  /**
   * The selection this instance executes: the active channel and the route key
   * that scopes message references to this deployment and target account.
   */
  async currentRoute(): Promise<RouteSnapshot> {
    this.routePromise ??= this.resolveRoute();
    return this.routePromise;
  }

  /** True while `routeKey` still describes this instance's selection. */
  async isAdmissionCurrent(
    channel: ChannelId,
    routeKey: string,
  ): Promise<boolean> {
    const route = await this.currentRoute();
    return route.channel === channel && route.routeKey === routeKey;
  }

  /** Sends on the selected channel and returns the owned message reference. */
  async sendCurrent(message: OutboundMessage): Promise<ChannelMessageRef> {
    const route = await this.currentRoute();
    if (route.channel === null) {
      throw new ChannelError("channel selection disabled", 0);
    }

    return this.sendOnRoute(route.channel, route.routeKey, message);
  }

  /**
   * 发送一个产物。产物不进 outbound 队列：15MB 的对象既不该进队列行，
   * 也不该把"文本能不能及时送达"绑在"这个文件能不能传上去"上。
   */
  async sendArtifact(key: string): Promise<void> {
    const route = await this.currentRoute();
    if (route.channel === null) {
      throw new ChannelError("channel selection disabled", 0);
    }
    if (artifactKeySegments(key) === null) {
      throw new ChannelError("invalid artifact key", 400);
    }

    const object = await artifactStore(this.env).get(key);
    if (!object) throw new ChannelError("artifact missing", 404);
    if (object.size > MAX_ARTIFACT_BYTES) {
      throw new ChannelError("artifact too large", 413);
    }

    const channel = route.channel;
    const file: OutboundArtifact = {
      name: artifactNameFromKey(key),
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      bytes: await object.arrayBuffer(),
    };

    await this.sendOwnerFile(channel, file);
  }

  /** One sender for owner bytes, so artifacts and images fail the same way. */
  private async sendOwnerFile(
    channel: ChannelId,
    file: OutboundArtifact,
  ): Promise<void> {
    try {
      await withRetry(async () => {
        await this.adapter(channel).sendArtifact(
          this.currentAddress(channel),
          file,
        );
      });
      emitChannelEvent(this.env, { channel, event: "send_ok" });
    } catch (error) {
      emitChannelEvent(this.env, {
        channel,
        event: "send_error",
        errorCode: channelErrorCode(error),
      });
      throw error;
    }
  }

  /** Edits only a reference owned by this instance's current route. */
  async editCurrent(
    ref: ChannelMessageRef,
    message: OutboundMessage,
  ): Promise<boolean> {
    const route = await this.currentRoute();
    if (
      route.channel === null ||
      ref.channel !== route.channel ||
      ref.routeKey !== route.routeKey ||
      ref.messageId === null ||
      route.channel === "wechat"
    ) {
      return false;
    }

    if (ref.conversationId !== this.currentAddress(route.channel)) {
      return false;
    }

    await this.adapter(route.channel).edit(
      ref.conversationId,
      ref.messageId,
      message,
    );
    return true;
  }

  private async resolveRoute(): Promise<RouteSnapshot> {
    const versionId = versionIdOf(this.env.CF_VERSION_METADATA);
    if (versionId === null) {
      console.error("channel: missing CF_VERSION_METADATA binding");
      return { channel: null, routeKey: DISABLED_ROUTE_KEY };
    }

    const channel = parseActiveChannel(this.env.ACTIVE_CHANNEL);
    if (channel === null) {
      console.error("channel: invalid ACTIVE_CHANNEL");
      return { channel: null, routeKey: DISABLED_ROUTE_KEY };
    }

    return routeIdentity({
      versionId,
      channel,
      targetIdentityHash: await this.targetIdentityHash(channel),
    });
  }

  /** Hashes the selected channel's account identity; never stores it plainly. */
  private targetIdentityHash(channel: ChannelId): Promise<string> {
    if (channel === "wechat") {
      // Route ownership comes from the deployed secret only: the test-only
      // polling override must never move an existing message reference.
      const raw = this.env.WECHAT_CREDENTIALS ?? null;
      return raw ? credentialsHash(raw) : sha256Hex("wechat:unconfigured");
    }

    // 认领是运行时状态，不参与这个哈希：认领后不必迁移已有的消息引用。
    const ownerIds = [
      ...new Set(readRuntimeConfig(this.env).owner?.telegramUserIds ?? []),
    ].sort((a, b) => a - b);
    return sha256Hex(
      `telegram:${this.env.TELEGRAM_BOT_TOKEN ?? ""}:${ownerIds.join(",")}`,
    );
  }

  private async sendOnRoute(
    channel: ChannelId,
    routeKey: string,
    msg: OutboundMessage,
  ): Promise<ChannelMessageRef> {
    const conversationId = this.currentAddress(channel);
    const outbound =
      channel === "wechat" ? forWechat(msg, ownerLocale(this.env)) : msg;

    if (channel !== "wechat") {
      const sent = await this.adapter(channel).send(conversationId, outbound);
      emitChannelEvent(this.env, { channel: "telegram", event: "send_ok" });
      return {
        channel,
        conversationId,
        routeKey,
        messageId: sent.messageId || null,
      };
    }

    // WeChat has no message ids and no retry of its own, so the message is
    // written down before anything talks to the network: a failure anywhere
    // after this point leaves a row behind instead of losing the message.
    // Only `drainOutbound` sends, and it goes in queue order, so a message
    // added here waits behind older ones and is delivered at least once.
    const { dropped } = this.outbound.enqueue({
      conversationId,
      text: outbound.text,
      buttons: outbound.buttons ?? null,
      priority: msg.priority,
    });
    if (dropped > 0) {
      console.error(`channel: outbound queue dropped ${dropped} oldest rows`);
    }
    await this.flushOutbound();
    return { channel, conversationId, routeKey, messageId: null };
  }

  /** Sends queued messages, oldest first. */
  async flushOutbound(): Promise<void> {
    if (this.outboundFlush !== null) {
      // A row may be added while the running drain is listing them: ask for
      // one more pass instead of leaving it for the next caller.
      this.outboundAgain = true;
      await this.outboundFlush;
      return;
    }
    this.outboundFlush = this.drainOutbound().finally(() => {
      this.outboundFlush = null;
    });
    await this.outboundFlush;
    if (this.outboundAgain) {
      this.outboundAgain = false;
      await this.flushOutbound();
    }
  }

  private async drainOutbound(): Promise<void> {
    if ((await this.currentRoute()).channel !== "wechat") return;
    let address: string;
    try {
      address = this.currentAddress("wechat");
    } catch {
      // No owner address yet: the rows wait for the first inbound message.
      return;
    }
    const adapter = this.adapter("wechat");

    for (const row of this.outbound.list()) {
      // A row for another conversation belongs to a former account (the chat
      // id changes with the credentials) and can never be delivered.
      if (row.conversationId !== address) {
        this.outbound.remove(row.id);
        console.error("channel: dropped a queued message for a former account");
        continue;
      }
      // One message the channel always rejects must not wedge the queue.
      if (row.attempts >= OUTBOUND_MAX_ATTEMPTS) {
        this.outbound.remove(row.id);
        console.error(
          `channel: gave up on a queued message after ${row.attempts} attempts`,
        );
        emitChannelEvent(this.env, {
          channel: "wechat",
          event: "send_error",
          errorCode: row.lastError ?? "api_error",
        });
        continue;
      }
      try {
        await adapter.send(row.conversationId, {
          text: row.text,
          ...(row.buttons === null ? {} : { buttons: row.buttons }),
        });
        this.outbound.remove(row.id);
      } catch (error) {
        // Order matters: later messages wait behind this one.
        this.reportSendFailure(row.id, error);
        return;
      }
    }
  }

  /** Records a rejected send as a sanitized event and keeps the row. */
  private reportSendFailure(id: number, error: unknown): void {
    const code = channelErrorCode(error);
    this.outbound.markError(id, code);
    emitChannelEvent(this.env, {
      channel: "wechat",
      event: "send_error",
      errorCode: code,
    });
    console.error(`channel: wechat send failed: ${errorMessage(error)}`);
  }

  /** Selected channel's conversation; never falls back to the other channel. */
  private currentAddress(channel: ChannelId): string {
    const row = this.db
      .exec<{ conversation_id: string }>(
        `SELECT conversation_id FROM owner_addresses WHERE channel = ?`,
        channel,
      )
      .toArray()[0];
    if (row) return row.conversation_id;

    if (channel === "telegram") {
      const fallback = readRuntimeConfig(this.env).owner?.telegramUserIds[0];
      if (fallback !== undefined) return String(fallback);
    }

    throw new ChannelError(`no ${channel} address`, 0);
  }

  async ensurePolling(): Promise<void> {
    if (this.lease.current() !== null) return;

    const route = await this.currentRoute();

    if (route.channel === "telegram") {
      await this.stopWeChatPolling();
      await this.stopMemberWeChatPolling();
      await this.startTelegramPolling();
      return;
    }

    if (route.channel === "wechat") {
      await this.stopTelegramPolling();
      await this.startWeChatPolling();
      // Each member connection polls on its own chain; the owner chain above
      // stays keyed by the deployed secret.
      await this.startMemberWeChatPolling();
      return;
    }

    await this.stopWeChatPolling();
    await this.stopMemberWeChatPolling();
    await this.stopTelegramPolling();
  }

  /** Stops the WeChat chain without discarding the selected credential. */
  private async stopWeChatPolling(): Promise<void> {
    this.activeWeChatRun = null;

    for (const schedule of await this.listSchedules()) {
      if (schedule.callback === "pollWeChat") {
        await this.cancelSchedule(schedule.id);
      }
    }

    // A deliberate deactivation is not an expiry: keep cursor and contexts so
    // selecting WeChat again resumes where it left off.
    if (this.readWeChatState().status === "running") {
      this.updateWeChatState({ status: "stopped" });
    }
  }

  /**
   * One-time adoption of the pre-members inbox. After the first pass the
   * marker turns this into a single SELECT, and a database that already has
   * members refuses to re-claim anything.
   */
  private async migrateLegacyAttachments(): Promise<void> {
    try {
      const artifacts = artifactStore(this.env);
      await migrateLegacyInbox({
        sql: this.db,
        access: this.attachments,
        list: async (cursor) => {
          const page = await artifacts.list({
            prefix: "inbox/",
            cursor,
            limit: 100,
          });
          return {
            keys: page.objects.map((object) => object.key),
            cursor: page.truncated ? page.cursor : undefined,
          };
        },
      });
    } catch (error) {
      // Not swallowed: the migration stays pending, so member activation keeps
      // failing closed until the backfill actually completes.
      console.error(
        `channel: legacy inbox migration failed: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Points the owner connection at the trusted credential. The credential is
   * saved in the private vault before the pointer moves; a failure here only
   * skips the metadata update, so single-owner polling is unchanged.
   */
  private async importWeChatOwner(
    credentials: WeChatCredentials,
    hash: string,
  ): Promise<void> {
    // Same credential after a redeploy: nothing to stage, nothing to advance.
    if (this.members.credentialHashOf(OWNER_ID) === hash) return;
    const previousKey = this.members.credentialKeyOf(OWNER_ID);
    const candidate = await stageCredentialAndActivate(
      this.staging,
      `wechat-owner-${hash.slice(0, 16)}`,
      credentials,
      (credentialKey) => {
        this.members.importOwner({
          connectionId: `wechat-owner-${credentials.accountId}`,
          credentialKey,
          accountId: credentials.accountId,
          userId: credentials.userId,
          credentialHash: hash,
        });
        return credentialKey;
      },
    );
    if (previousKey !== null && previousKey !== candidate) {
      // The pointer moved; the old key is unreachable now.
      await this.vault.delete(previousKey);
    }
  }

  private async startWeChatPolling(): Promise<void> {
    const raw = this.weChatCredentialsJson();
    if (!raw) return;

    const credentials = parseCredentials(raw);
    if (!credentials) {
      this.updateWeChatState({ status: "stopped" });
      console.error("channel: invalid WECHAT_CREDENTIALS");
      return;
    }
    if (!isTrustedBaseUrl(credentials.baseUrl)) {
      // Keep the credential stored but expose the same visible state as an
      // expired session. Re-scanning replaces it; no token is ever sent to an
      // untrusted origin.
      this.updateWeChatState({ status: "expired", expiry_notified: 1 });
      console.warn("channel: WECHAT_CREDENTIALS_UNTRUSTED_BASE_URL");
      return;
    }

    const hash = await credentialsHash(raw);
    try {
      await this.importWeChatOwner(credentials, hash);
    } catch (error) {
      if (error instanceof MemberError && error.code === "MEMBER_ACCESS_DENIED") {
        // A member already holds this account/user: the legacy owner path must
        // not admit the rejected identity. Leave stored metadata untouched and
        // do not install this hash or start polling with it.
        console.error(
          "channel: owner binding rejected: identity belongs to a member",
        );
        return;
      }
      console.warn(
        `channel: owner binding not imported: ${errorMessage(error)}`,
      );
    }
    let state = this.readWeChatState();
    if (state.credentials_hash !== hash) {
      this.activeWeChatRun = null;
      this.db.exec("DELETE FROM wechat_contexts");
      this.updateWeChatState({
        credentials_hash: hash,
        cursor: null,
        status: "running",
        last_poll_at: null,
        expiry_notified: 0,
      });
      state = this.readWeChatState();
    }

    // Same credentials after a redeploy: resume a deliberate stop, but never
    // resurrect an expired session without new scanned credentials.
    if (state.status === "stopped") {
      this.updateWeChatState({ status: "running" });
      state = this.readWeChatState();
    }

    if (state.status !== "running") return;

    // Tests drive pollWeChat explicitly. Scheduling here would start a live
    // chain that can fire before the test installs its scripted fetch.
    if (getPollTimingOverride()?.manualStart) return;

    const now = Date.now();
    if (
      state.last_poll_at !== null &&
      now - state.last_poll_at < WECHAT_HEARTBEAT_MAX_AGE_MS
    ) {
      return;
    }

    const pending = await this.listSchedules();
    if (
      pending.some(
        (schedule) =>
          schedule.callback === "pollWeChat" && schedule.time * 1000 > now,
      )
    ) {
      return;
    }

    // Idempotent so a schedule(0) that is already due still counts as pending.
    await this.schedule(0, "pollWeChat", undefined, { idempotent: true });
  }

  /** Stops the Telegram chain without discarding the offset. */
  private async stopTelegramPolling(): Promise<void> {
    this.activeTelegramRun = null;

    for (const schedule of await this.listSchedules()) {
      if (schedule.callback === "pollTelegram") {
        await this.cancelSchedule(schedule.id);
      }
    }

    // A deliberate deactivation is not an expiry: keep the offset so selecting
    // Telegram again resumes where it left off.
    if (this.readTelegramState().status === "running") {
      this.updateTelegramState({ status: "stopped" });
    }
  }

  private async startTelegramPolling(): Promise<void> {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;

    const hash = await sha256Hex(token);
    let state = this.readTelegramState();
    if (state.token_hash !== hash) {
      // New or replaced token: a former expiry no longer applies.
      this.activeTelegramRun = null;
      this.updateTelegramState({
        token_hash: hash,
        offset: 0,
        status: "running",
        last_poll_at: null,
        expired_version: null,
      });
      state = this.readTelegramState();
    }

    // Same token after a redeploy: resume a deliberate stop, but never
    // resurrect an expired token without new credentials.
    if (state.status === "stopped") {
      this.updateTelegramState({ status: "running" });
      state = this.readTelegramState();
    }

    // A rejected token is retried once after a redeploy. The same version
    // stays expired so a bad token does not poll in a loop.
    const versionId = this.env.CF_VERSION_METADATA?.id ?? "";
    if (state.status === "expired" && state.expired_version !== versionId) {
      this.updateTelegramState({
        status: "running",
        expired_version: null,
      });
      state = this.readTelegramState();
    }

    if (state.status !== "running") return;

    // Tests drive pollTelegram explicitly. Scheduling here would start a live
    // chain that can fire before the test installs its scripted fetch.
    if (getPollTimingOverride()?.manualStart) return;

    const now = Date.now();
    if (
      state.last_poll_at !== null &&
      now - state.last_poll_at < TELEGRAM_HEARTBEAT_MAX_AGE_MS
    ) {
      return;
    }

    const pending = await this.listSchedules();
    if (
      pending.some(
        (schedule) =>
          schedule.callback === "pollTelegram" && schedule.time * 1000 > now,
      )
    ) {
      return;
    }

    // Idempotent so a schedule(0) that is already due still counts as pending.
    await this.schedule(0, "pollTelegram", undefined, { idempotent: true });
  }

  /**
   * One long-poll step. A 409 means an older deployment still has a webhook
   * registered: remove it without `drop_pending_updates` (the backlog is kept)
   * and retry once.
   */
  private async fetchTelegramBatch(
    client: TelegramPollClient,
    offset: number,
    ownsRun: () => Promise<boolean>,
    retry: TelegramWebhookRetry,
  ): Promise<TelegramUpdateBatch | "stopped"> {
    try {
      return await client.getUpdates(
        offset,
        AbortSignal.timeout(TELEGRAM_GET_UPDATES_TIMEOUT_MS),
      );
    } catch (error) {
      if (
        !(error instanceof ChannelError) ||
        error.status !== 409 ||
        retry.attempted
      ) {
        throw error;
      }

      retry.attempted = true;
      await client.deleteWebhook(
        AbortSignal.timeout(TELEGRAM_GET_UPDATES_TIMEOUT_MS),
      );

      if (!(await ownsRun())) return "stopped";
      this.updateTelegramState({ last_poll_at: Date.now() });
      return await client.getUpdates(
        offset,
        AbortSignal.timeout(TELEGRAM_GET_UPDATES_TIMEOUT_MS),
      );
    }
  }

  async pollTelegram(
    _payload?: unknown,
    _schedule?: Schedule<unknown>,
  ): Promise<void> {
    if (this.lease.current() !== null) return;

    const route = await this.currentRoute();
    if (route.channel !== "telegram") return;

    const token = this.env.TELEGRAM_BOT_TOKEN;
    const state = this.readTelegramState();
    if (!token || state.status !== "running" || !state.token_hash) return;
    if (this.activeTelegramRun) return;
    const run = { token, hash: state.token_hash, routeKey: route.routeKey };
    this.activeTelegramRun = run;
    const ownsRun = async () => {
      const current = this.readTelegramState();
      return this.activeTelegramRun === run &&
        this.lease.current() === null &&
        this.env.TELEGRAM_BOT_TOKEN === run.token &&
        current.token_hash === run.hash && current.status === "running" &&
        (await this.currentRoute()).routeKey === run.routeKey;
    };

    try {
      const timing = getPollTimingOverride() ?? {
        runMs: TELEGRAM_POLL_RUN_MS,
        baseBackoffMs: TELEGRAM_POLL_BACKOFF_MS,
      };
      const client = createTelegramPollClient({
        token,
        fetch: getTelegramFetchOverride() ?? undefined,
      });
      const startedAt = Date.now();
      const retry: TelegramWebhookRetry = { attempted: false };

      do {
        if (!(await ownsRun())) return;
        // Refresh the heartbeat before the long poll so ensurePolling does not
        // start a second chain while getUpdates is still waiting.
        this.updateTelegramState({ last_poll_at: Date.now() });

        let batch: TelegramUpdateBatch;
        try {
          const fetched = await this.fetchTelegramBatch(
            client,
            this.readTelegramState().offset,
            ownsRun,
            retry,
          );
          if (fetched === "stopped") return;
          batch = fetched;
        } catch (error) {
          if (!(await ownsRun())) return;
          if (
            error instanceof ChannelError &&
            (error.status === 401 || error.status === 404)
          ) {
            emitChannelEvent(this.env, {
              channel: "telegram",
              event: "poll_expired",
              errorCode: "credential_invalid",
            });
            this.updateTelegramState({
              status: "expired",
              expired_version: this.env.CF_VERSION_METADATA?.id ?? "",
            });
            console.warn("channel: telegram token invalid, polling stopped");
            return;
          }
          emitChannelEvent(this.env, {
            channel: "telegram",
            event: "poll_error",
            errorCode: channelErrorCode(error),
          });
          console.error(
            `channel: telegram poll failed: ${errorMessage(error)}`,
          );
          const backoffMs = this.telegramBackoffMs ?? timing.baseBackoffMs;
          await sleep(backoffMs);
          this.telegramBackoffMs = Math.min(
            backoffMs * 2,
            TELEGRAM_POLL_MAX_BACKOFF_MS,
          );
          continue;
        }

        retry.attempted = false;
        if (!(await ownsRun())) return;
        emitChannelEvent(this.env, {
          channel: "telegram",
          event: "poll_ok",
        });
        this.updateTelegramState({ last_poll_at: Date.now() });

        for (const update of batch.updates) {
          if (!(await ownsRun())) return;
          const outcome = await this.handleTelegramUpdate(update);
          // The lease landed mid-batch: keep this update's offset so the Cron
          // replays it after the restore releases the lease.
          if (outcome === "maintenance") return;
          this.updateTelegramState({ offset: update.update_id + 1 });
        }
        this.telegramBackoffMs = null;
      } while (Date.now() - startedAt < timing.runMs);

      if (!(await ownsRun())) return;
      await this.schedule(0, "pollTelegram");
    } finally {
      if (this.activeTelegramRun === run) this.activeTelegramRun = null;
    }
  }

  async pollWeChat(
    _payload?: unknown,
    _schedule?: Schedule<unknown>,
  ): Promise<void> {
    if (this.lease.current() !== null) return;

    const route = await this.currentRoute();
    if (route.channel !== "wechat") return;

    const raw = this.weChatCredentialsJson();
    const credentials = raw ? parseCredentials(raw) : null;
    const state = this.readWeChatState();
    if (!credentials || !raw || state.status !== "running" || !state.credentials_hash) return;
    if (this.activeWeChatRun) return;
    const run = { hash: state.credentials_hash, raw, routeKey: route.routeKey };
    this.activeWeChatRun = run;
    const ownsRun = async () => {
      const current = this.readWeChatState();
      return this.activeWeChatRun === run &&
        this.lease.current() === null &&
        this.weChatCredentialsJson() === run.raw &&
        current.credentials_hash === run.hash && current.status === "running" &&
        (await this.currentRoute()).routeKey === run.routeKey;
    };

    try {
      const timing = getPollTimingOverride() ?? {
        runMs: WECHAT_POLL_RUN_MS,
        baseBackoffMs: WECHAT_POLL_BACKOFF_MS,
      };
      const client = createILinkClient({
        fetch: getILinkFetchOverride() ?? undefined,
      });
      const startedAt = Date.now();

      do {
        if (!(await ownsRun())) return;
        const cursor = this.readWeChatState().cursor ?? "";
        // Refresh the heartbeat before the long poll only when the previous
        // one is stale, so ensurePolling does not start a second chain while
        // getupdates is still waiting. A fresh heartbeat already does that.
        const lastPollAt = this.readWeChatState().last_poll_at;
        if (
          lastPollAt === null ||
          Date.now() - lastPollAt > WECHAT_PREPOLL_HEARTBEAT_MS
        ) {
          this.updateWeChatState({ last_poll_at: Date.now() });
        }

        try {
          const batch = await client.getUpdates(
            credentials,
            cursor,
            AbortSignal.timeout(WECHAT_GET_UPDATES_TIMEOUT_MS),
          );
          if (!(await ownsRun())) return;
          emitChannelEvent(this.env, {
            channel: "wechat",
            event: "poll_ok",
          });
          // 下载和解码可能要几秒，先把心跳刷新掉，别让 ensurePolling 以为
          // 这条链死了而再起一条。
          this.updateWeChatState({ last_poll_at: Date.now() });
          // 先处理再记 cursor：媒体处理途中被杀掉时游标没有前进，下一轮
          // iLink 会把这一批重发；反过来先存 cursor，这一批就永久丢了。
          const outcome = await this.dispatchWeChatUpdates(
            batch.updates,
            batch.cursor,
            credentials,
            run.routeKey,
          );
          if (outcome === "maintenance") return;
          this.updateWeChatState({
            cursor: batch.cursor,
            last_poll_at: Date.now(),
          });
          this.weChatBackoffMs = null;
        } catch (error) {
          if (!(await ownsRun())) return;
          if (isSessionExpired(error)) {
            emitChannelEvent(this.env, {
              channel: "wechat",
              event: "poll_expired",
              errorCode: "session_expired",
            });
            await this.expireWeChat();
            return;
          }
          emitChannelEvent(this.env, {
            channel: "wechat",
            event: "poll_error",
            errorCode: channelErrorCode(error),
          });
          console.error(
            `channel: wechat poll failed: ${errorMessage(error)}`,
          );
          const backoffMs = this.weChatBackoffMs ?? timing.baseBackoffMs;
          await sleep(backoffMs);
          this.weChatBackoffMs = Math.min(
            backoffMs * 2,
            WECHAT_POLL_MAX_BACKOFF_MS,
          );
        }
      } while (Date.now() - startedAt < timing.runMs);

      if (!(await ownsRun())) return;
      await this.schedule(0, "pollWeChat");
    } finally {
      if (this.activeWeChatRun === run) this.activeWeChatRun = null;
    }
  }

  private async expireWeChat(): Promise<void> {
    this.updateWeChatState({ status: "expired", expiry_notified: 1 });
    // Never notify through another channel; re-scan to obtain new credentials.
    console.warn("channel: wechat session expired, run the login script");
  }

  private async dispatchWeChatUpdates(
    updates: WeChatUpdate[],
    cursor: string,
    credentials: WeChatCredentials,
    routeKey: string,
  ): Promise<"accepted" | "maintenance"> {
    // A lease can be acquired while getUpdates is in flight. Do not admit the
    // batch or write session context into a database that is being restored.
    if (this.lease.current() !== null) return "maintenance";
    const media: Array<{ event: MessageEvent; item: WeChatMediaItem }> = [];
    updates.forEach((update, index) => {
      if (
        update.messageType !== 1 ||
        update.fromUserId !== credentials.userId
      ) {
        return;
      }

      if (update.contextToken) {
        this.db.exec(
          `INSERT INTO wechat_contexts (user_id, context_token, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             context_token = excluded.context_token,
             updated_at = excluded.updated_at`,
          update.fromUserId,
          update.contextToken,
          Date.now(),
        );
        // The token just refreshed; anything the channel rejected earlier can
        // go out now.
        this.ctx.waitUntil(
          this.flushOutbound().catch((error: unknown) => {
            console.error(
              `channel: outbound flush failed: ${errorMessage(error)}`,
            );
          }),
        );
      }

      const eventId = `wx:${update.messageId ?? `${cursor}:${index}`}`;
      const event: MessageEvent = {
        type: "message",
        channel: "wechat",
        chatId: update.fromUserId,
        userId: update.fromUserId,
        text: update.text,
        ...(update.quotedText ? { quotedText: update.quotedText } : {}),
        ...(update.voice && !update.text ? { voiceFailed: true } : {}),
        eventId,
      };
      this.rememberOwner(event, ownerPrincipal());

      // Deterministic owner commands replace the missing WeChat buttons.
      const shareCommand =
        update.text === null ? null : parseShareCommand(update.text);
      if (shareCommand !== null) {
        this.ctx.waitUntil(this.handleOwnerShareCommand(shareCommand, routeKey));
        return;
      }
      const textAction =
        update.text === null ? null : parseTextAction(update.text);
      if (textAction !== null) {
        this.dispatchWeChatAction(event, eventId, routeKey, textAction);
        return;
      }

      if (update.media.length > 0) {
        // 一条消息可以带多个图片或文件（多选发送、合并转发），每个 item 单独
        // 下发：单张图的 base64 必须留在 ChannelDO → ButlerDO 的大小上限以内，
        // 一张失败也不会牵连同一条消息里的其他图。文字只跟第一个 item 走，
        // 其余 item 只带附件，避免同一句说明重复进模型上下文。
        update.media.forEach((item, i) => {
          const itemEvent: MessageEvent = {
            ...event,
            ...(i === 0 ? {} : { text: null }),
            eventId:
              update.media.length === 1 ? eventId : `${eventId}:${i}`,
          };
          media.push({ event: itemEvent, item });
        });
        return;
      }

      this.dispatchMessage(event, routeKey);
    });

    // 一个接一个地下载和解码：Photon 的 wasm 堆不收缩，几张图同时解码就把
    // isolate 的内存撞满，整批一起进不了管家。等到这里全部处理完，调用方
    // 才推进 cursor；中途被杀掉时 cursor 没动，iLink 会重发这一批。
    for (const entry of media) {
      if (this.lease.current() !== null) return "maintenance";
      if (entry.item.kind === "image") {
        await this.dispatchWeChatImage(entry.event, entry.item.image, routeKey);
      } else {
        await this.dispatchWeChatFile(entry.event, entry.item.file, routeKey);
      }
    }
    return "accepted";
  }

  /**
   * WeChat hands over an image as an encrypted CDN object. The caller runs one
   * of these at a time: decoding is the memory-heavy step, and two at once can
   * take an isolate down with the whole batch.
   */
  private async dispatchWeChatImage(
    event: MessageEvent,
    image: WeChatImageRef,
    routeKey: string,
    trust?: MediaTrust,
  ): Promise<void> {
    const client = createILinkClient({
      fetch: getILinkFetchOverride() ?? undefined,
    });
    const bytes = await client.downloadImage(image);
    // A member download is only admitted while its own principal, ref and
    // route are still live: a revoke mid-download must not store bytes or
    // reach a Butler.
    if (!(await this.mediaAdmissionCurrent(trust, routeKey))) return;
    if (!bytes) {
      console.warn(`channel: wechat image download failed (${event.eventId})`);
      this.dispatchMediaEvent({ ...event, imageFailed: true }, routeKey, trust);
      return;
    }

    const prepared = await prepareInboundImage(bytes);
    if (!(await this.mediaAdmissionCurrent(trust, routeKey))) return;
    if (!prepared.ok) {
      // The CDN answers 200 even when the body is not the image the item
      // promised, so name what arrived: key present, header bytes, format.
      const key = image.aesKeyHex
        ? "hex"
        : image.mediaAesKey
          ? "base64"
          : "none";
      const detail =
        prepared.detail === undefined
          ? ""
          : ` detail=${prepared.detail.slice(0, 120)}`;
      console.warn(
        `channel: wechat image unusable (${event.eventId})` +
          ` reason=${prepared.reason} key=${key} ${describeImageBytes(bytes)}${detail}`,
      );
      this.dispatchMediaEvent({ ...event, imageFailed: true }, routeKey, trust);
      return;
    }

    const files: InboundFile[] = [];
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      // The inbox copy is a convenience and the model image is prepared from
      // the same bytes; an oversized original just skips the copy.
      console.warn(
        `channel: wechat image not stored in inbox (${event.eventId}):` +
          ` larger than ${MAX_ARTIFACT_BYTES} bytes`,
      );
    } else {
      try {
        const mimeType = sniffImageType(bytes) ?? prepared.image.mimeType;
        const extension = extensionForMime(mimeType) ?? "jpg";
        files.push(
          await inboxStore(artifactStore(this.env))(
            event.eventId,
            `image.${extension}`,
            bytes,
            mimeType,
          ),
        );
      } catch (error) {
        // The inbox copy is a convenience; the image itself still reaches the
        // butler even when R2 refuses the write.
        console.error(
          `channel: wechat inbox store failed (${event.eventId}): ${errorMessage(error)}`,
        );
      }
    }

    this.dispatchMediaEvent(
      { ...event, images: [prepared.image], ...(files.length > 0 ? { files } : {}) },
      routeKey,
      trust,
    );
  }

  /**
   * Re-checks a member media action's admission. The owner path has no trust
   * context and is never gated here, so its behaviour is unchanged.
   */
  private async mediaAdmissionCurrent(
    trust: MediaTrust | undefined,
    routeKey: string,
  ): Promise<boolean> {
    if (trust === undefined) return true;
    return await this.isMemberAdmissionCurrent(
      trust.actor,
      "wechat",
      trust.ref,
      routeKey,
    );
  }

  /** Dispatches with the member's own actor/ref, or on the legacy owner path. */
  private dispatchMediaEvent(
    event: MessageEvent,
    routeKey: string,
    trust: MediaTrust | undefined,
  ): void {
    if (trust === undefined) {
      this.dispatchMessage(event, routeKey);
      return;
    }
    this.dispatchMessage(event, routeKey, {
      actor: trust.actor,
      ref: trust.ref,
    });
  }

  /**
   * WeChat hands files over as encrypted CDN objects too. The butler only gets
   * the inbox reference, so a large download never enters the message event.
   */
  private async dispatchWeChatFile(
    event: MessageEvent,
    file: WeChatFileRef,
    routeKey: string,
    trust?: MediaTrust,
  ): Promise<void> {
    if (file.size !== undefined && file.size > MAX_ARTIFACT_BYTES) {
      if (!(await this.mediaAdmissionCurrent(trust, routeKey))) return;
      this.dispatchMediaEvent({ ...event, fileFailed: "too_large" }, routeKey, trust);
      return;
    }

    const client = createILinkClient({
      fetch: getILinkFetchOverride() ?? undefined,
    });
    const bytes = await client.downloadFile(file);
    // Same rule as images: the bytes belong to whoever is still admitted
    // after the download, so a revoke in between wins.
    if (!(await this.mediaAdmissionCurrent(trust, routeKey))) return;
    if (!bytes) {
      console.warn(`channel: wechat file download failed (${event.eventId})`);
      this.dispatchMediaEvent({ ...event, fileFailed: "download" }, routeKey, trust);
      return;
    }
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      this.dispatchMediaEvent({ ...event, fileFailed: "too_large" }, routeKey, trust);
      return;
    }

    const { mimeType } = classifyFile(bytes, "", file.name);
    try {
      const stored = await inboxStore(artifactStore(this.env))(
        event.eventId,
        file.name,
        bytes,
        mimeType,
      );
      if (!(await this.mediaAdmissionCurrent(trust, routeKey))) return;
      this.dispatchMediaEvent({ ...event, files: [stored] }, routeKey, trust);
    } catch (error) {
      console.error(
        `channel: wechat inbox store failed (${event.eventId}): ${errorMessage(error)}`,
      );
      if (!(await this.mediaAdmissionCurrent(trust, routeKey))) return;
      this.dispatchMediaEvent({ ...event, fileFailed: "download" }, routeKey, trust);
    }
  }

  private dispatchWeChatAction(
    event: MessageEvent,
    eventId: string,
    routeKey: string,
    parsed: TextAction,
  ): void {
    this.ctx.waitUntil(
      this.handleWeChatAction(event, eventId, routeKey, parsed).catch(
        (error: unknown) => {
          console.error(`channel: action failed: ${errorMessage(error)}`);
        },
      ),
    );
  }

  /**
   * The owner confirms a share from its own WeChat session. The same code path
   * as a member's, with the owner actor and the owner's own send.
   */
  private async handleOwnerShareCommand(
    command: ShareCommand,
    routeKey: string,
  ): Promise<void> {
    if (!(await this.isAdmissionCurrent("wechat", routeKey))) return;
    const text = await this.shareReplyText(ownerPrincipal(), command);
    if (!(await this.isAdmissionCurrent("wechat", routeKey))) return;
    await this.sendCurrent({ text });
  }

  private async handleWeChatAction(
    event: MessageEvent,
    eventId: string,
    routeKey: string,
    parsed: TextAction,
  ): Promise<void> {
    if (!(await this.isAdmissionCurrent("wechat", routeKey))) return;

    // The legacy `t<n>` form needs no lookup: the id is already the target.
    let target: { taskId: string; label: string; approvalId?: string } | null =
      parsed.target.kind === "taskId"
        ? {
            taskId: parsed.target.taskId,
            label: parsed.target.taskId,
            ...(parsed.approvalId === undefined
              ? {}
              : { approvalId: parsed.approvalId }),
          }
        : null;

    if (target === null) {
      try {
        const butler = this.env.BUTLER.get(
          this.env.BUTLER.idFromName("owner"),
        );
        const resolution = await butler.resolveTextAction(parsed);
        if (resolution.kind === "chat") {
          // The Butler already had its round trip, so a later message in this
          // batch may reach it first. Best-effort ordering is acceptable here.
          this.dispatchMessage(event, routeKey);
          return;
        }
        if (resolution.kind === "reply") {
          if (!(await this.isAdmissionCurrent("wechat", routeKey))) return;
          await this.sendCurrent({ text: resolution.text });
          return;
        }
        target = {
          taskId: resolution.taskId,
          label: resolution.label,
          ...(resolution.approvalId === undefined
            ? {}
            : { approvalId: resolution.approvalId }),
        };
      } catch (error) {
        console.error(
          `channel: action resolution failed: ${errorMessage(error)}`,
        );
        if (!(await this.isAdmissionCurrent("wechat", routeKey))) return;
        await this.sendCurrent({
          text: channelErrorText(ownerLocale(this.env)),
        });
        return;
      }
    }

    let text = channelErrorText(ownerLocale(this.env));
    try {
      const action: ActionEvent = {
        type: "action",
        channel: "wechat",
        chatId: event.chatId,
        userId: event.userId,
        actionId: eventId,
        messageId: eventId,
        action: parsed.action,
        taskId: target.taskId,
        ...(target.approvalId === undefined
          ? {}
          : { approvalId: target.approvalId }),
        eventId,
      };
      const task = this.env.TASK.get(
        this.env.TASK.idFromName(action.taskId),
      );
      // This legacy action path is the owner's WeChat session; member text
      // commands are routed through their own Butler and stay denied here.
      text = await task.handleAction(action, ownerPrincipal());
      if (target.label !== target.taskId) {
        text = replaceTaskId(text, target.taskId, target.label);
      }
    } catch (error) {
      console.error(`channel: action failed: ${errorMessage(error)}`);
    }

    if (!(await this.isAdmissionCurrent("wechat", routeKey))) return;
    await this.sendCurrent({ text });
  }

  private weChatCredentialsJson(): string | null {
    return getWeChatCredentialsOverride() ?? this.env.WECHAT_CREDENTIALS ?? null;
  }

  private parseWeChatCredentials(): WeChatCredentials | null {
    const raw = this.weChatCredentialsJson();
    return raw ? parseCredentials(raw) : null;
  }

  private readWeChatState(): WeChatState {
    return (
      this.db
        .exec<WeChatState>(
          `SELECT credentials_hash, cursor, status, last_poll_at,
                  expiry_notified
           FROM wechat_state LIMIT 1`,
        )
        .toArray()[0] ?? {
        credentials_hash: null,
        cursor: null,
        status: null,
        last_poll_at: null,
        expiry_notified: 0,
      }
    );
  }

  private updateWeChatState(patch: Partial<WeChatState>): void {
    const next = { ...this.readWeChatState(), ...patch };
    this.db.exec(
      `INSERT INTO wechat_state
         (credentials_hash, cursor, status, last_poll_at, expiry_notified)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM wechat_state)`,
      next.credentials_hash,
      next.cursor,
      next.status,
      next.last_poll_at,
      next.expiry_notified,
    );
    this.db.exec(
      `UPDATE wechat_state SET
         credentials_hash = ?,
         cursor = ?,
         status = ?,
         last_poll_at = ?,
         expiry_notified = ?`,
      next.credentials_hash,
      next.cursor,
      next.status,
      next.last_poll_at,
      next.expiry_notified,
    );
  }

  private readTelegramState(): TelegramState {
    return (
      this.db
        .exec<TelegramState>(
          `SELECT token_hash, offset, status, last_poll_at, expired_version
           FROM telegram_state WHERE id = 1`,
        )
        .toArray()[0] ?? {
        token_hash: null,
        offset: 0,
        status: null,
        last_poll_at: null,
        expired_version: null,
      }
    );
  }

  /** Upserts the single row, writing only the columns the patch names. */
  private updateTelegramState(patch: Partial<TelegramState>): void {
    const columns = [
      "token_hash",
      "offset",
      "status",
      "last_poll_at",
      "expired_version",
    ] as const;
    const changed = columns.filter((key) => patch[key] !== undefined);
    if (changed.length === 0) return;

    const next: TelegramState = {
      token_hash: null,
      offset: 0,
      status: null,
      last_poll_at: null,
      expired_version: null,
      ...patch,
    };
    this.db.exec(
      `INSERT INTO telegram_state (id, ${columns.join(", ")})
       VALUES (1, ${columns.map(() => "?").join(", ")})
       ON CONFLICT(id) DO UPDATE SET ${changed
         .map((key) => `${key} = excluded.${key}`)
         .join(", ")}`,
      ...columns.map((key) => next[key]),
    );
  }

  private wechatAdapter(): ChannelAdapter {
    const client = createILinkClient({
      fetch: getILinkFetchOverride() ?? undefined,
    });
    const hub = this;

    return {
      parseInbound: async () => null,
      send: async (chatId, msg) => {
        const credentials = hub.parseWeChatCredentials();
        if (!credentials) {
          throw new ChannelError("wechat not configured", 0);
        }

        const context = hub.db
          .exec<{ context_token: string }>(
            `SELECT context_token FROM wechat_contexts WHERE user_id = ?`,
            chatId,
          )
          .toArray()[0]?.context_token;
        if (!context) {
          throw new ChannelError("wechat context missing", 0);
        }

        if (msg.text.length === 0) return { messageId: "" };
        await client.sendText(credentials, chatId, context, msg.text);
        emitChannelEvent(hub.env, { channel: "wechat", event: "send_ok" });
        return { messageId: "" };
      },
      sendArtifact: async (chatId, file) => {
        const credentials = hub.parseWeChatCredentials();
        if (!credentials) throw new ChannelError("wechat not configured", 0);

        const context = hub.db
          .exec<{ context_token: string }>(
            `SELECT context_token FROM wechat_contexts WHERE user_id = ?`,
            chatId,
          )
          .toArray()[0]?.context_token;
        if (!context) throw new ChannelError("wechat context missing", 0);

        await client.sendMedia(credentials, chatId, context, file);
        emitChannelEvent(hub.env, { channel: "wechat", event: "send_ok" });
      },
      edit: async () => {},
      answerAction: async () => {},
    };
  }

  private dispatchMessage(
    event: MessageEvent,
    routeKey: string,
    context?: { actor: Principal; ref: ConnectionRef },
  ): boolean {
    // Fail closed for a poll or webhook already in flight when the lease was
    // acquired: the Butler must not start new work against half-saved data.
    if (this.lease.current() !== null) return false;

    // The owner actor wrapper delegates to the legacy path only after the
    // directory confirms the principal is still the owner.
    if (context !== undefined && context.actor.memberId === OWNER_ID) {
      try {
        this.members.assertActive(context.actor);
      } catch {
        return false;
      }
    }

    // Admitted inbound files become ACL rows immediately, so a key stored
    // after the one-time backfill still resolves. The subject is the actor's
    // member id; legacy ingress is the owner.
    this.registerInboundFiles(event, context?.actor.memberId ?? OWNER_ID);

    if (context !== undefined && context.actor.memberId !== OWNER_ID) {
      return this.dispatchMemberMessage(event, routeKey, context);
    }

    try {
      const admitted: AdmittedMessage = { ...event, routeKey };
      const butler = this.env.BUTLER.get(
        this.env.BUTLER.idFromName("owner"),
      );
      // Telegram retries slow webhooks; acknowledge now and let the Butler run.
      this.ctx.waitUntil(
        butler.handleMessage(admitted).catch((error: unknown) => {
          console.error(
            `channel: message dispatch failed: ${errorMessage(error)}`,
          );
        }),
      );
      return true;
    } catch (error) {
      console.error(
        `channel: message dispatch failed: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  /**
   * Member dispatch boundary. Task 5 owns the Butler side; this runtime only
   * depends on the narrow contract `initializeMember` then `handleMessage`, on
   * the member's own Butler name. A Butler build without it fails closed: a
   * member message is never handed to the owner's Butler.
   */
  private dispatchMemberMessage(
    event: MessageEvent,
    routeKey: string,
    context: { actor: Principal; ref: ConnectionRef },
  ): boolean {
    const butler: Partial<MemberButlerRpc> =
      getMemberButlerOverride() ??
      (this.env.BUTLER.get(
        this.env.BUTLER.idFromName(butlerName(context.actor.memberId)),
      ) as unknown as Partial<MemberButlerRpc>);
    if (
      typeof butler.initializeMember !== "function" ||
      typeof butler.handleMessage !== "function"
    ) {
      // Fail closed: no owner fallback and no uninitialised member session.
      console.error("channel: member dispatch unavailable, message dropped");
      return false;
    }

    const admitted: AdmittedMessage = {
      ...event,
      routeKey,
      actor: context.actor,
      connectionRef: context.ref,
    };
    this.ctx.waitUntil(
      (async () => {
        try {
          // The member Butler must know its actor before it reads any state.
          await butler.initializeMember?.(context.actor);
          // Re-check after the await: a revoke during initialisation wins.
          if (
            !(await this.isMemberAdmissionCurrent(
              context.actor,
              "wechat",
              context.ref,
              routeKey,
            ))
          ) {
            return;
          }
          await butler.handleMessage?.(admitted);
        } catch (error) {
          console.error(
            `channel: member message dispatch failed: ${errorMessage(error)}`,
          );
        }
      })(),
    );
    return true;
  }

  private ownerConfig(): OwnerConfigView {
    return {
      telegramUserIds: readRuntimeConfig(this.env).owner?.telegramUserIds,
    };
  }

  /** 静态配置下不碰认领表：那会把一个正常运行的部署写成待认领。 */
  private claim(): OwnerClaimView {
    return this.ownerConfig().telegramUserIds === undefined
      ? this.owners.ensureWindow()
      : { ownerUserId: null, windowOpenedAt: 0 };
  }

  private ownerAccess(event: InboundEvent): OwnerDecision {
    // 只有 Telegram 有认领；微信的 userId 来自登录凭据，不走这里。
    if (event.channel !== "telegram") return "deny";
    return decideOwner({
      config: this.ownerConfig(),
      claim: this.claim(),
      userId: event.userId,
      now: Date.now(),
    });
  }

  private async claimOwner(event: InboundEvent): Promise<void> {
    this.owners.claim(event.userId);
    emitChannelEvent(this.env, { channel: "telegram", event: "owner_claimed" });
    try {
      await this.adapter("telegram").send(event.chatId, {
        text: t(ownerLocale(this.env), "channel.owner.claimed", {
          id: event.userId,
        }),
      });
    } catch (error) {
      console.error(`channel: claim receipt failed: ${errorMessage(error)}`);
    }
  }

  private rememberOwner(event: InboundEvent, actor: Principal): void {
    // The owner address book belongs to the owner only. A member's inbound
    // writes its own connection row instead, and an unproven actor writes
    // nothing at all.
    if (actor.memberId !== OWNER_ID || actor.role !== "owner") return;
    try {
      this.members.assertActive(actor);
    } catch {
      return;
    }
    this.db.exec(
      `INSERT INTO owner_addresses (channel, conversation_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         updated_at = excluded.updated_at`,
      event.channel,
      event.chatId,
      Date.now(),
    );
  }

  private adapter(channel: ChannelId): ChannelAdapter {
    const override = getChannelOverride(channel);
    if (override) return override;

    if (channel === "wechat") {
      return this.wechatAdapter();
    }

    this.telegramInstance ??= createTelegramAdapter({
      token: this.env.TELEGRAM_BOT_TOKEN,
      ai: this.env.AI,
      storeFile: inboxStore(artifactStore(this.env)),
    });
    return this.telegramInstance;
  }
}
