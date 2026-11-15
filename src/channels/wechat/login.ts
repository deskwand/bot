/**
 * Durable WeChat member binding.
 *
 * The machine is deliberately not an in-memory singleton: every method
 * reloads its state, performs at most one bounded HTTP step, persists the
 * result and returns. A page GET, an alarm or a rebuilt instance can therefore
 * resume at realname / scan / pin / confirmed-save without a polling loop.
 *
 * Two invariants make it safe under concurrency and restarts:
 *
 * 1. Every write is a compare-and-swap on `invite_id + generation` (plus the
 *    stage or activation flag the caller read). A stale instance — older
 *    generation, delayed network return, revoked invite — loses the CAS and
 *    writes nothing: it never overwrites the current row and never deletes the
 *    vault record of another generation.
 * 2. Activation is claimed by CAS, so exactly one caller runs `onConfirmed`
 *    even when the gate is not shared. Recovery from a `saving` row only
 *    trusts the durable `activationStatus` receipt; without it the flow ends
 *    as `interrupted` and is never replayed.
 *
 * Secrets (QR token, real-name ticket, capability tokens) live in the private
 * vault under a per-generation key; SQL only carries non-sensitive
 * progression. The PIN never leaves the request that submits it.
 */
import {
  ILinkError,
  REALNAME_TICKET_MIN_MS,
  REALNAME_WAIT_MS,
  createILinkClient,
  credentialsFromQrStatus,
  isTrustedBaseUrl,
  transportFailureOf,
  type WeChatCredentials,
} from "./ilink.ts";
import { CredentialVault } from "../../members/credentials.ts";

export type LoginStage =
  | "idle"
  | "realname"
  | "scan"
  | "pin"
  | "saving"
  | "confirmed"
  | "denied"
  | "expired"
  | "cancelled"
  | "failed";

export type LoginFailure =
  | "protocol"
  | "realname_denied"
  | "ticket_refresh_exhausted"
  | "ticket_expiring"
  | "credentials_missing"
  | "untrusted_redirect"
  | "binded_elsewhere"
  | "pin_blocked"
  | "invite_not_live"
  | "activation_failed"
  | "expired"
  /** Activation was claimed but no durable receipt proves it committed. */
  | "interrupted";

/** Public page state. Never carries the QR token, tickets, PINs or tokens. */
export type InviteView = {
  inviteId: string;
  stage: LoginStage;
  expiresAt: number;
  generation: number;
  scanned: boolean;
  qrImage?: string;
  /** Operator-only: where the real-name verification is completed. */
  authUrl?: string;
  failure?: LoginFailure;
};

/** Every field here is safe to keep in SQL. */
export type LoginState = {
  inviteId: string;
  generation: number;
  stage: LoginStage;
  expiresAt: number;
  realnameDeadline: number;
  /** A refreshed real-name ticket may only be requested once. */
  ticketRefreshed: boolean;
  /** Number of QR codes issued for this binding, capped at three. */
  qrCount: number;
  /** A QR code exists in the vault and has not expired yet. */
  qrPending: boolean;
  scanned: boolean;
  redirectBaseUrl: string | null;
  /** Durable guard: `onConfirmed` is invoked at most once. */
  activationStarted: boolean;
  /** When activation was claimed; the lease that separates "in flight" from "crashed". */
  activationAt: number;
  failure: LoginFailure | null;
};

/** Private vault record. Never returned by `view()`. */
export type LoginSecrets = {
  inviteeToken: string;
  operatorToken: string;
  qrcode?: string;
  qrImage?: string;
  realnameTicket?: string;
  authUrl?: string;
  spamTicket?: string;
};

/** Guard for one guarded write. `generation` is required: no unguarded writes. */
export type LoginSwapExpect = {
  generation: number;
  stage?: LoginStage;
  activationStarted?: boolean;
};

export type LoginSwapResult = {
  /** True when the stored row still matched and the write applied. */
  applied: boolean;
  /** The stored row after the attempt (`null` when there is no row). */
  current: LoginState | null;
};

/**
 * Durable non-sensitive progression. Every mutation is a storage-level
 * compare-and-swap, so two instances (or a delayed response) cannot interleave
 * a read/modify/write pair.
 */
export interface LoginStateStore {
  load(inviteId: string): Promise<LoginState | null>;
  /** Inserts only when the invite has no row yet. */
  create(state: LoginState): Promise<LoginSwapResult>;
  /** Writes `state` only when the stored row still matches `expect`. */
  swap(state: LoginState, expect: LoginSwapExpect): Promise<LoginSwapResult>;
  /** Deletes only a row of `expect.generation`. */
  delete(inviteId: string, expect: { generation: number }): Promise<LoginSwapResult>;
}

/** Secrets are generation-scoped so a stale caller cannot touch the current flow. */
export interface LoginSecretStore {
  get(inviteId: string, generation: number): Promise<LoginSecrets | undefined>;
  put(inviteId: string, generation: number, secrets: LoginSecrets): Promise<void>;
  delete(inviteId: string, generation: number): Promise<void>;
}

/** Invite liveness is owned by `MemberStore`; Task 8 supplies the lookup. */
export type InviteLiveCheck = (
  inviteId: string,
  generation: number,
) => Promise<boolean>;

/**
 * Authoritative proof that activation committed, read from `MemberStore`.
 * Task 8 wires it like:
 *
 *   activationStatus: async (inviteId, generation) => {
 *     const invite = await members.getInvite(inviteId);
 *     if (!invite || invite.generation !== generation) return "pending";
 *     if (!invite.consumedAt) return "pending";
 *     const member = await members.getMember(invite.memberId);
 *     return member?.status === "active" ? "committed" : "pending";
 *   }
 *
 * Anything other than `"committed"` — including a throw — is treated as
 * "pending", which ends a `saving` recovery as `interrupted` without replay.
 */
export type ActivationStatus = (
  inviteId: string,
  generation: number,
) => Promise<"committed" | "pending">;

export type WeChatLoginTransport = Pick<
  ReturnType<typeof createILinkClient>,
  "getRealnameAuthUrl" | "queryRealnameResult" | "getBotQrCode" | "getQrStatus"
>;

export type LoginGate = {
  /** Serialises work per invite so two requests never drive one QR twice. */
  run<T>(inviteId: string, fn: () => Promise<T>): Promise<T>;
};

export function createLoginGate(): LoginGate {
  const chains = new Map<string, Promise<unknown>>();
  return {
    run<T>(inviteId: string, fn: () => Promise<T>): Promise<T> {
      const previous = chains.get(inviteId) ?? Promise.resolve();
      const next = previous.then(fn, fn);
      const tail = next.then(
        () => undefined,
        () => undefined,
      );
      chains.set(inviteId, tail);
      // Prune the settled chain so the map does not grow with every invite.
      void tail.then(() => {
        if (chains.get(inviteId) === tail) chains.delete(inviteId);
      });
      return next;
    },
  };
}

export type WeChatLoginOptions = {
  inviteId: string;
  generation: number;
  /** Invite expiry; no operation survives it. */
  expiresAt: number;
  state: LoginStateStore;
  secrets: LoginSecretStore;
  transport: WeChatLoginTransport;
  /** The only way credentials leave this module. */
  onConfirmed(credentials: WeChatCredentials): Promise<void>;
  /** Durable proof of activation; required so a restart is never guessed. */
  activationStatus: ActivationStatus;
  /** Defaults to "live"; Task 8 must pass `MemberStore`-backed lookup. */
  inviteLive?: InviteLiveCheck;
  /** Recent bot tokens to link; read at QR issuance, never persisted here. */
  localTokens?:
    | readonly string[]
    | (() => readonly string[] | Promise<readonly string[]>);
  now?: () => number;
  gate?: LoginGate;
  /** Upper bound on one upstream step. Defaults to 20 s. */
  stepTimeoutMs?: number;
};

const MAX_QR_CODES = 3;
const PIN_PATTERN = /^\d{6}$/;
const DEFAULT_STEP_TIMEOUT_MS = 20_000;
/**
 * A `saving` row younger than this may still be driven by another instance;
 * only an older one is a crash to recover from.
 */
const ACTIVATION_LEASE_MS = 60_000;
const TERMINAL_STAGES: readonly LoginStage[] = [
  "confirmed",
  "denied",
  "expired",
  "cancelled",
  "failed",
];

type Wire<T> =
  | { ok: true; value: T }
  | { ok: false; outcome: "terminal" | "retry" | "abort" };

export class WeChatLogin {
  private readonly options: WeChatLoginOptions;

  private readonly state: LoginStateStore;

  private readonly secrets: LoginSecretStore;

  private readonly transport: WeChatLoginTransport;

  private readonly gate: LoginGate;

  private readonly now: () => number;

  private readonly stepTimeoutMs: number;

  private cachedState: LoginState | null = null;

  private cachedSecrets: LoginSecrets | undefined;

  constructor(options: WeChatLoginOptions) {
    this.options = options;
    this.state = options.state;
    this.secrets = options.secrets;
    this.transport = options.transport;
    this.gate = options.gate ?? createLoginGate();
    this.now = options.now ?? (() => Date.now());
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  }

  /** Re-reads durable state for a page GET. Performs no network request. */
  async load(): Promise<void> {
    const state = await this.state.load(this.options.inviteId);
    this.cachedState = state;
    this.cachedSecrets = state
      ? await this.secrets.get(this.options.inviteId, state.generation)
      : undefined;
  }

  view(): InviteView {
    const state = this.cachedState;
    if (!state) {
      return {
        inviteId: this.options.inviteId,
        stage: "idle",
        expiresAt: this.options.expiresAt,
        generation: this.options.generation,
        scanned: false,
      };
    }
    const showQr = state.stage === "scan" || state.stage === "pin";
    const secrets = this.cachedSecrets;
    return {
      inviteId: state.inviteId,
      stage: state.stage,
      expiresAt: state.expiresAt,
      generation: state.generation,
      scanned: state.scanned,
      ...(showQr && secrets?.qrImage ? { qrImage: secrets.qrImage } : {}),
      ...(state.stage === "realname" && secrets?.authUrl
        ? { authUrl: secrets.authUrl }
        : {}),
      ...(state.failure ? { failure: state.failure } : {}),
    };
  }

  /**
   * Operator path: prove real-name status, then issue the invitee QR.
   * At most three bounded requests (auth URL, one poll, first QR). An expired,
   * cancelled or stale-generation invite never reaches the network.
   */
  async startOtherOwner(): Promise<void> {
    await this.exclusive(async () => {
      const existing = await this.state.load(this.options.inviteId);
      if (existing) {
        const secrets = await this.secrets.get(
          this.options.inviteId,
          existing.generation,
        );
        this.cache(existing, secrets);
        if (this.isStale(existing) || this.isTerminal(existing)) return;
        if (existing.stage !== "realname") return;
        await this.realnameStep(existing, secrets);
        await this.issueFirstQr();
        return;
      }
      if (this.now() >= this.options.expiresAt) return;
      const created = this.freshState();
      const inserted = await this.state.create(created);
      const state = inserted.current;
      if (!state) return;
      if (inserted.applied) {
        await this.writeSecrets(this.newSecrets());
        this.cache(state);
      } else {
        this.cache(
          state,
          await this.secrets.get(this.options.inviteId, state.generation),
        );
      }
      if (this.isStale(state) || this.isTerminal(state)) return;
      if (state.stage !== "realname") return;
      await this.realnameStep(state, this.cachedSecrets);
      await this.issueFirstQr();
    });
  }

  /**
   * Operator path only: the invitee page needs the first QR in the same call.
   * `advance` never does this, so one advance stays one network step.
   */
  private async issueFirstQr(): Promise<void> {
    const state = this.cachedState;
    if (!state || state.stage !== "scan" || state.qrPending) return;
    await this.issueQr(state, this.cachedSecrets);
  }

  /** One bounded step: a real-name poll, a QR request or a status poll. */
  async advance(): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.state.load(this.options.inviteId);
      if (!state) return;
      const secrets = await this.secrets.get(
        this.options.inviteId,
        state.generation,
      );
      this.cache(state, secrets);
      if (this.isStale(state) || this.isTerminal(state)) return;
      if (state.stage === "saving") {
        // Recovery runs before expiry/liveness: the invite may already be
        // consumed by the activation we are trying to confirm.
        await this.recoverSave(state);
        return;
      }
      if (!(await this.liveByClock(state))) return;
      if (!(await this.inviteLive(state))) return;

      if (state.stage === "realname") {
        await this.realnameStep(state, secrets);
        return;
      }
      if (state.stage === "scan") {
        if (!secrets?.qrcode || !state.qrPending) {
          await this.issueQr(state, secrets);
          return;
        }
        const qrcode = secrets.qrcode;
        const expect: LoginSwapExpect = {
          generation: this.options.generation,
          stage: "scan",
          activationStarted: false,
        };
        const result = await this.wire(
          state,
          () =>
            this.transport.getQrStatus(qrcode, this.stepSignal(), {
              ...(state.redirectBaseUrl
                ? { baseUrl: state.redirectBaseUrl }
                : {}),
            }),
          expect,
        );
        if (!result.ok) return;
        await this.applyStatus(state, secrets, result.value, false, expect);
        return;
      }
      // pin: waits for `submitPin`; nothing to poll without the PIN.
    });
  }

  /**
   * The PIN stays in this call: the next poll is issued here, never deferred
   * to a future alarm. An aborted poll discards the PIN by returning to
   * `scan`, so the same code can never be replayed.
   */
  async submitPin(pin: string): Promise<void> {
    if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) {
      throw new Error("WECHAT_LOGIN_PIN_INVALID");
    }
    await this.exclusive(async () => {
      const state = await this.state.load(this.options.inviteId);
      if (!state) throw new Error("WECHAT_LOGIN_PIN_INVALID");
      const secrets = await this.secrets.get(
        this.options.inviteId,
        state.generation,
      );
      this.cache(state, secrets);
      if (this.isStale(state)) throw new Error("WECHAT_LOGIN_PIN_INVALID");
      if (state.stage !== "pin" || !secrets?.qrcode) {
        throw new Error("WECHAT_LOGIN_PIN_INVALID");
      }
      if (!(await this.liveByClock(state))) return;
      if (!(await this.inviteLive(state))) return;

      const qrcode = secrets.qrcode;
      const expect: LoginSwapExpect = { generation: this.options.generation, stage: "pin" };
      const result = await this.wire(
        state,
        () =>
          this.transport.getQrStatus(qrcode, this.stepSignal(), {
            verifyCode: pin,
            ...(state.redirectBaseUrl
              ? { baseUrl: state.redirectBaseUrl }
              : {}),
          }),
        expect,
      );
      if (!result.ok) {
        if (result.outcome === "abort") {
          // The server may or may not have consumed the code; never resend it.
          await this.commit({ ...state, stage: "scan" }, expect);
        }
        return;
      }
      await this.applyStatus(state, secrets, result.value, true, expect);
    });
  }

  /** Terminal, no network. A late `confirmed` can never activate a member. */
  async cancel(): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.state.load(this.options.inviteId);
      if (!state) return;
      this.cache(
        state,
        await this.secrets.get(this.options.inviteId, state.generation),
      );
      if (this.isStale(state) || this.isTerminal(state)) return;
      // Activation in flight may already have created the member; recovery,
      // not cancel, decides that outcome.
      if (state.activationStarted || state.stage === "saving") return;
      const expect: LoginSwapExpect = {
        generation: this.options.generation,
        stage: state.stage,
        activationStarted: false,
      };
      const next: LoginState = {
        ...state,
        stage: "cancelled",
        failure: null,
        qrPending: false,
      };
      if (!(await this.commit(next, expect))) return;
      await this.cleanup(this.options.generation);
    });
  }

  /**
   * Explicit generation reset for a rebind: a *newer* generation may discard a
   * previous flow that never reached activation. A stale instance (older
   * generation) can never take over, and an in-flight activation is never
   * discarded.
   */
  async reset(): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.state.load(this.options.inviteId);
      if (!state) return;
      this.cache(state);
      if (state.generation >= this.options.generation) return;
      if (state.stage === "saving") return;
      const removed = await this.state.delete(this.options.inviteId, {
        generation: state.generation,
      });
      if (!removed.applied) return;
      await this.cleanup(state.generation);
      this.cachedState = null;
    });
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return await this.gate.run(this.options.inviteId, fn);
  }

  /** One bounded real-name step: fetch a ticket, or poll the current one. */
  private async realnameStep(
    state: LoginState,
    secrets: LoginSecrets | undefined,
  ): Promise<void> {
    if (!(await this.liveByClock(state))) return;
    const expect: LoginSwapExpect = {
      generation: this.options.generation,
      stage: "realname",
    };
    let current: LoginSecrets | null | undefined = secrets;
    if (!current?.realnameTicket) {
      const auth = await this.wire(
        state,
        () => this.transport.getRealnameAuthUrl(this.stepSignal()),
        expect,
      );
      if (!auth.ok) return;
      current = await this.storeAuth(state, auth.value, expect, current);
      if (!current) return;
    }
    const ticket = current.realnameTicket;
    if (!ticket) return void (await this.fail(state, "protocol", expect));
    const result = await this.wire(
      state,
      () => this.transport.queryRealnameResult(ticket, this.stepSignal()),
      expect,
    );
    if (!result.ok) return;
    await this.applyRealname(state, current, result.value, expect);
  }

  /** Persists a fetched auth URL and returns the merged vault record. */
  private async storeAuth(
    state: LoginState,
    auth: { authUrl: string; ticket: string; expiresAt?: number },
    expect: LoginSwapExpect,
    secrets: LoginSecrets | undefined,
  ): Promise<LoginSecrets | null> {
    const deadline =
      auth.expiresAt === undefined
        ? state.realnameDeadline
        : Math.min(state.realnameDeadline, auth.expiresAt);
    if (!(await this.commit({ ...state, realnameDeadline: deadline }, expect))) {
      return null;
    }
    const merged: LoginSecrets = {
      ...(secrets ?? this.newSecrets()),
      realnameTicket: auth.ticket,
      authUrl: auth.authUrl,
    };
    await this.writeSecrets(merged);
    return merged;
  }

  /**
   * Applies a real-name poll. A refresh only drops the ticket: the replacement
   * is fetched by the next step, so one call never performs two requests.
   */
  private async applyRealname(
    state: LoginState,
    secrets: LoginSecrets,
    result: Awaited<
      ReturnType<WeChatLoginTransport["queryRealnameResult"]>
    >,
    expect: LoginSwapExpect,
  ): Promise<LoginState | null> {
    if (this.now() >= state.realnameDeadline) {
      await this.fail(state, "expired", expect);
      return null;
    }
    if (result.status === "denied") {
      await this.fail(state, "realname_denied", expect);
      return null;
    }
    if (result.status === "ok") {
      const remaining =
        result.expiresAt === undefined ? Infinity : result.expiresAt - this.now();
      if (remaining < REALNAME_TICKET_MIN_MS) {
        await this.fail(state, "ticket_expiring", expect);
        return null;
      }
      const next: LoginState = { ...state, stage: "scan" };
      if (!(await this.commit(next, expect))) return null;
      await this.writeSecrets({
        ...secrets,
        spamTicket: result.ticket ?? secrets.realnameTicket,
      });
      return next;
    }
    if (result.status === "refresh") {
      if (state.ticketRefreshed) {
        await this.fail(state, "ticket_refresh_exhausted", expect);
        return null;
      }
      if (!(await this.commit({ ...state, ticketRefreshed: true }, expect))) {
        return null;
      }
      const dropped: LoginSecrets = { ...secrets };
      delete dropped.realnameTicket;
      delete dropped.authUrl;
      await this.writeSecrets(dropped);
      return null;
    }
    // wait
    this.cache(state, secrets);
    return null;
  }

  private async issueQr(
    state: LoginState,
    secrets: LoginSecrets | undefined,
  ): Promise<void> {
    const expect: LoginSwapExpect = {
      generation: this.options.generation,
      stage: "scan",
      activationStarted: false,
    };
    if (!secrets) return void (await this.fail(state, "protocol", expect));
    if (state.qrCount >= MAX_QR_CODES) {
      await this.fail(state, "expired", expect);
      return;
    }
    const localTokens = await this.readLocalTokens();
    const qr = await this.wire(
      state,
      () =>
        this.transport.getBotQrCode(this.stepSignal(), {
          localTokens,
          ...(secrets.spamTicket ? { spamTicket: secrets.spamTicket } : {}),
        }),
      expect,
    );
    if (!qr.ok) return;
    const next: LoginState = {
      ...state,
      qrCount: state.qrCount + 1,
      qrPending: true,
      scanned: false,
      redirectBaseUrl: null,
    };
    if (!(await this.commit(next, expect))) return;
    await this.writeSecrets({
      ...secrets,
      qrcode: qr.value.qrcode,
      qrImage: qr.value.imageContent,
    });
  }

  private async applyStatus(
    state: LoginState,
    secrets: LoginSecrets,
    result: Awaited<ReturnType<WeChatLoginTransport["getQrStatus"]>>,
    fromPin: boolean,
    expect: LoginSwapExpect,
  ): Promise<void> {
    switch (result.status) {
      case "wait":
        this.cache(state, secrets);
        return;
      case "scaned": {
        const next: LoginState = {
          ...state,
          scanned: true,
          stage: fromPin ? "scan" : state.stage,
        };
        if (await this.commit(next, expect)) this.cachedSecrets = secrets;
        return;
      }
      case "scaned_but_redirect": {
        const redirect = result.redirectBaseUrl;
        if (!redirect || !isTrustedBaseUrl(redirect)) {
          await this.fail(state, "untrusted_redirect", expect);
          return;
        }
        // Never carry a PIN to a new origin: it is only kept for the poll that
        // already happened. The next poll is PIN-free anyway.
        const next: LoginState = {
          ...state,
          scanned: true,
          redirectBaseUrl: redirect,
          stage: fromPin ? "scan" : state.stage,
        };
        if (await this.commit(next, expect)) this.cachedSecrets = secrets;
        return;
      }
      case "need_verifycode": {
        const next: LoginState = { ...state, stage: "pin", scanned: true };
        if (await this.commit(next, expect)) this.cachedSecrets = secrets;
        return;
      }
      case "verify_code_blocked":
      case "verify_code_expired":
        // The PIN is rejected; fail closed instead of retrying it forever.
        await this.fail(state, "pin_blocked", expect);
        return;
      case "binded_redirect":
        await this.fail(state, "binded_elsewhere", expect);
        return;
      case "expired": {
        if (state.qrCount >= MAX_QR_CODES) {
          await this.fail(state, "expired", expect);
          return;
        }
        const next: LoginState = {
          ...state,
          qrPending: false,
          scanned: false,
          stage: "scan",
        };
        if (await this.commit(next, expect)) this.cachedSecrets = secrets;
        return;
      }
      case "confirmed":
        await this.activate(state, result.raw, expect);
        return;
      default:
        await this.fail(state, "protocol", expect);
    }
  }

  /**
   * Claims activation with a CAS, so exactly one caller runs the callback even
   * without a shared gate. A loser writes nothing and returns.
   */
  private async activate(
    state: LoginState,
    raw: Record<string, unknown>,
    expect: LoginSwapExpect,
  ): Promise<void> {
    const credentials = credentialsFromQrStatus(raw);
    if (!credentials) {
      await this.fail(state, "credentials_missing", expect);
      return;
    }
    if (!(await this.liveByClock(state))) return;
    if (!(await this.inviteLive(state))) return;

    const claim: LoginState = {
      ...state,
      stage: "saving",
      activationStarted: true,
      activationAt: this.now(),
      qrPending: false,
      failure: null,
    };
    if (!(await this.commit(claim, { ...expect, activationStarted: false }))) {
      return;
    }
    try {
      await this.options.onConfirmed(credentials);
    } catch {
      await this.fail(claim, "activation_failed", {
        generation: this.options.generation,
        stage: "saving",
        activationStarted: true,
      });
      return;
    }
    await this.completeSave(claim);
  }

  /**
   * Resolves a crash after the activation claim. Only a durable
   * `activationStatus` receipt turns it into `confirmed`; an in-flight claim
   * (younger than the lease) is left alone, anything else ends as
   * `interrupted` and is never replayed.
   */
  private async recoverSave(state: LoginState): Promise<void> {
    if (this.now() - state.activationAt < ACTIVATION_LEASE_MS) return;
    const expect: LoginSwapExpect = {
      generation: this.options.generation,
      stage: "saving",
      activationStarted: true,
    };
    if ((await this.activationProof(state)) === "committed") {
      await this.completeSave(state);
      return;
    }
    await this.fail(state, "interrupted", expect);
  }

  private async activationProof(
    state: LoginState,
  ): Promise<"committed" | "pending"> {
    try {
      const value = await this.options.activationStatus(
        state.inviteId,
        state.generation,
      );
      return value === "committed" ? "committed" : "pending";
    } catch {
      return "pending";
    }
  }

  /** Records a committed activation without ever invoking the callback again. */
  private async completeSave(state: LoginState): Promise<void> {
    const expect: LoginSwapExpect = {
      generation: this.options.generation,
      stage: "saving",
      activationStarted: true,
    };
    const next: LoginState = {
      ...state,
      stage: "confirmed",
      qrPending: false,
      failure: null,
    };
    if (!(await this.commit(next, expect))) return;
    await this.cleanup(this.options.generation);
  }

  private async inviteLive(state: LoginState): Promise<boolean> {
    const live = await (this.options.inviteLive?.(
      state.inviteId,
      state.generation,
    ) ?? Promise.resolve(true));
    if (!live) {
      await this.fail(state, "invite_not_live", {
        generation: this.options.generation,
        stage: state.stage,
      });
      return false;
    }
    return true;
  }

  /** Expiry checks run before any network step. */
  private async liveByClock(state: LoginState): Promise<boolean> {
    const now = this.now();
    if (
      now >= state.expiresAt ||
      (state.stage === "realname" && now >= state.realnameDeadline)
    ) {
      await this.fail(state, "expired", {
        generation: this.options.generation,
        stage: state.stage,
      });
      return false;
    }
    return true;
  }

  /**
   * Terminal failure. The terminal row is persisted first; secret cleanup is
   * best effort and a failed cleanup never revives the flow.
   */
  private async fail(
    state: LoginState,
    failure: LoginFailure,
    expect: LoginSwapExpect,
  ): Promise<boolean> {
    const next: LoginState = {
      ...state,
      stage:
        failure === "expired"
          ? "expired"
          : failure === "realname_denied"
            ? "denied"
            : "failed",
      failure,
      qrPending: false,
      scanned: false,
    };
    if (!(await this.commit(next, expect))) return false;
    await this.cleanup(this.options.generation);
    return true;
  }

  /** Best-effort vault cleanup. Failures are inert, never a state change. */
  private async cleanup(generation: number): Promise<void> {
    try {
      await this.secrets.delete(this.options.inviteId, generation);
    } catch {
      // The terminal row is already durable; the stale vault record is inert
      // and is re-deleted by the next reset/activation of this invite.
    }
    this.cachedSecrets = undefined;
  }

  /** Guarded write. Returns false (and caches the winner) when the CAS loses. */
  private async commit(
    state: LoginState,
    expect: LoginSwapExpect,
  ): Promise<boolean> {
    if (state.generation !== this.options.generation) return false;
    const result = await this.state.swap(state, {
      ...expect,
      generation: this.options.generation,
    });
    if (result.applied) {
      this.cachedState = { ...state };
      return true;
    }
    this.cachedState = result.current ? { ...result.current } : null;
    if (
      !result.current ||
      result.current.generation !== this.options.generation
    ) {
      this.cachedSecrets = undefined;
    }
    return false;
  }

  /** Runs one transport call and maps its failure onto the retry contract. */
  private async wire<T>(
    state: LoginState,
    call: () => Promise<T>,
    expect: LoginSwapExpect,
  ): Promise<Wire<T>> {
    try {
      return { ok: true, value: await call() };
    } catch (error) {
      const failure = transportFailureOf(error);
      if (failure === "abort") return { ok: false, outcome: "abort" };
      if (failure === "transient") return { ok: false, outcome: "retry" };
      await this.fail(state, loginFailureOf(error), expect);
      return { ok: false, outcome: "terminal" };
    }
  }

  /** A bounded signal for one upstream step. */
  private stepSignal(): AbortSignal {
    return AbortSignal.timeout(this.stepTimeoutMs);
  }

  private cache(
    state: LoginState,
    secrets: LoginSecrets | undefined = this.cachedSecrets,
  ): void {
    this.cachedState = { ...state };
    this.cachedSecrets = secrets;
  }

  private async writeSecrets(secrets: LoginSecrets): Promise<void> {
    await this.secrets.put(
      this.options.inviteId,
      this.options.generation,
      secrets,
    );
    this.cachedSecrets = { ...secrets };
  }

  private async readLocalTokens(): Promise<readonly string[]> {
    const source = this.options.localTokens;
    if (!source) return [];
    return typeof source === "function" ? await source() : source;
  }

  private newSecrets(): LoginSecrets {
    return {
      inviteeToken: randomToken(),
      operatorToken: randomToken(),
    };
  }

  private freshState(): LoginState {
    const now = this.now();
    return {
      inviteId: this.options.inviteId,
      generation: this.options.generation,
      stage: "realname",
      expiresAt: this.options.expiresAt,
      realnameDeadline: Math.min(
        this.options.expiresAt,
        now + REALNAME_WAIT_MS,
      ),
      ticketRefreshed: false,
      qrCount: 0,
      qrPending: false,
      scanned: false,
      redirectBaseUrl: null,
      activationStarted: false,
      activationAt: 0,
      failure: null,
    };
  }

  /** A row of another generation belongs to a different binding: never touch it. */
  private isStale(state: LoginState): boolean {
    return state.generation !== this.options.generation;
  }

  private isTerminal(state: LoginState): boolean {
    return TERMINAL_STAGES.includes(state.stage);
  }
}

/** Security failures keep their distinct, page-visible reason. */
function loginFailureOf(error: unknown): LoginFailure {
  return error instanceof ILinkError &&
    error.message === "WECHAT_ILINK_UNTRUSTED_REDIRECT"
    ? "untrusted_redirect"
    : "protocol";
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Vault key for one binding generation; exported for the Task 8 page layer. */
export function loginSecretKey(inviteId: string, generation: number): string {
  return `login:${inviteId}:${generation}`;
}

const LOGIN_STATE_TABLE = `CREATE TABLE IF NOT EXISTS wechat_login (
  invite_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  stage TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  realname_deadline INTEGER NOT NULL,
  ticket_refreshed INTEGER NOT NULL DEFAULT 0,
  qr_count INTEGER NOT NULL DEFAULT 0,
  qr_pending INTEGER NOT NULL DEFAULT 0,
  scanned INTEGER NOT NULL DEFAULT 0,
  redirect_base_url TEXT,
  activation_started INTEGER NOT NULL DEFAULT 0,
  activation_at INTEGER NOT NULL DEFAULT 0,
  failure TEXT
)`;

const LOGIN_STATE_COLUMNS = `invite_id, generation, stage, expires_at,
  realname_deadline, ticket_refreshed, qr_count, qr_pending, scanned,
  redirect_base_url, activation_started, activation_at, failure`;

type LoginRow = {
  invite_id: string;
  generation: number;
  stage: string;
  expires_at: number;
  realname_deadline: number;
  ticket_refreshed: number;
  qr_count: number;
  qr_pending: number;
  scanned: number;
  redirect_base_url: string | null;
  activation_started: number;
  activation_at: number;
  failure: string | null;
};

/**
 * Durable non-sensitive progression with storage-level compare-and-swap.
 * Every write is a single `UPDATE ... WHERE`, so the read/modify/write pair of
 * two instances can never interleave.
 */
export class SqlLoginStateStore implements LoginStateStore {
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.sql.exec(LOGIN_STATE_TABLE);
    // Rows created before `activation_at` existed keep 0, which reads as an
    // expired lease and therefore as a crash to recover.
    try {
      this.sql.exec(
        `ALTER TABLE wechat_login ADD COLUMN activation_at INTEGER NOT NULL DEFAULT 0`,
      );
    } catch {
      // Column already present.
    }
  }

  async load(inviteId: string): Promise<LoginState | null> {
    const row = this.sql
      .exec<LoginRow>(
        `SELECT ${LOGIN_STATE_COLUMNS} FROM wechat_login WHERE invite_id = ?`,
        inviteId,
      )
      .toArray()[0];
    return row ? stateOf(row) : null;
  }

  async create(state: LoginState): Promise<LoginSwapResult> {
    const cursor = this.sql.exec(
      `INSERT OR IGNORE INTO wechat_login (${LOGIN_STATE_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...valuesOf(state),
    );
    return await this.result(state.inviteId, cursor.rowsWritten > 0, state);
  }

  async swap(
    state: LoginState,
    expect: LoginSwapExpect,
  ): Promise<LoginSwapResult> {
    const guards: string[] = ["invite_id = ?", "generation = ?"];
    const args: unknown[] = [state.inviteId, expect.generation];
    if (expect.stage !== undefined) {
      guards.push("stage = ?");
      args.push(expect.stage);
    }
    if (expect.activationStarted !== undefined) {
      guards.push("activation_started = ?");
      args.push(expect.activationStarted ? 1 : 0);
    }
    const cursor = this.sql.exec(
      `UPDATE wechat_login SET
         generation = ?, stage = ?, expires_at = ?, realname_deadline = ?,
         ticket_refreshed = ?, qr_count = ?, qr_pending = ?, scanned = ?,
         redirect_base_url = ?, activation_started = ?, activation_at = ?,
         failure = ?
       WHERE ${guards.join(" AND ")}`,
      ...valuesOf(state).slice(1),
      ...args,
    );
    return await this.result(state.inviteId, cursor.rowsWritten > 0, state);
  }

  async delete(
    inviteId: string,
    expect: { generation: number },
  ): Promise<LoginSwapResult> {
    const cursor = this.sql.exec(
      `DELETE FROM wechat_login WHERE invite_id = ? AND generation = ?`,
      inviteId,
      expect.generation,
    );
    return await this.result(inviteId, cursor.rowsWritten > 0, null);
  }

  private async result(
    inviteId: string,
    applied: boolean,
    written: LoginState | null,
  ): Promise<LoginSwapResult> {
    return {
      applied,
      current: applied ? written : await this.load(inviteId),
    };
  }
}

/** Column order for `LOGIN_STATE_COLUMNS`. */
function valuesOf(state: LoginState): unknown[] {
  return [
    state.inviteId,
    state.generation,
    state.stage,
    state.expiresAt,
    state.realnameDeadline,
    state.ticketRefreshed ? 1 : 0,
    state.qrCount,
    state.qrPending ? 1 : 0,
    state.scanned ? 1 : 0,
    state.redirectBaseUrl,
    state.activationStarted ? 1 : 0,
    state.activationAt,
    state.failure,
  ];
}

function stateOf(row: LoginRow): LoginState {
  return {
    inviteId: row.invite_id,
    generation: row.generation,
    stage: row.stage as LoginStage,
    expiresAt: row.expires_at,
    realnameDeadline: row.realname_deadline,
    ticketRefreshed: row.ticket_refreshed !== 0,
    qrCount: row.qr_count,
    qrPending: row.qr_pending !== 0,
    scanned: row.scanned !== 0,
    redirectBaseUrl: row.redirect_base_url,
    activationStarted: row.activation_started !== 0,
    activationAt: row.activation_at,
    failure: (row.failure as LoginFailure | null) ?? null,
  };
}

/** Private vault storage on top of the existing WeChat credential namespace. */
export class VaultLoginSecretStore implements LoginSecretStore {
  private readonly vault: CredentialVault;

  constructor(storage: DurableObjectStorage) {
    this.vault = new CredentialVault(storage);
  }

  async get(
    inviteId: string,
    generation: number,
  ): Promise<LoginSecrets | undefined> {
    return await this.vault.get<LoginSecrets>(
      loginSecretKey(inviteId, generation),
    );
  }

  async put(
    inviteId: string,
    generation: number,
    secrets: LoginSecrets,
  ): Promise<void> {
    await this.vault.put(loginSecretKey(inviteId, generation), secrets);
  }

  async delete(inviteId: string, generation: number): Promise<void> {
    await this.vault.delete(loginSecretKey(inviteId, generation));
  }
}
