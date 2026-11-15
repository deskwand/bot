import type { Provider } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { registerTestProvider, setModelOverride } from "../../src/llm/models";
import { butlerName, ownerPrincipal, OWNER_ID } from "../../src/members/principal";
import { MemberStore } from "../../src/members/store";
import type { AdmittedMessage, RouteSnapshot } from "../../src/protocol";
import { fakeChannel } from "../helpers/fake-channel";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { memberBinding } from "../helpers/members";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

let route: RouteSnapshot;

// Member routes exist only while WeChat is the selected channel.
const ENV = env as unknown as Record<string, unknown>;
const originalChannel = ENV.ACTIVE_CHANNEL;
ENV.ACTIVE_CHANNEL = "wechat";

// The whole file runs with WeChat selected; restoring it mid-file would make
// later routes disagree with the ones already computed.
void originalChannel;

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function task(taskId: string) {
  return env.TASK.get(env.TASK.idFromName(taskId));
}

/** One scripted response per model request, recording the prompt it saw. */
type Turn = { text?: string; toolCalls?: { name: string; args: unknown }[] };

function userTextOf(context: TranscriptContext): string {
  const last = context.messages.filter((entry) => entry.role === "user").at(-1);
  if (last === undefined || last.role !== "user") return "";
  return typeof last.content === "string"
    ? last.content
    : JSON.stringify(last.content);
}

/**
 * Responses are chosen by the user text that triggered them, so one shared
 * provider cannot drift out of order when a Butler makes extra requests.
 */
function scripted(
  turns: Turn[],
  byMarker: { marker: string; turn: Turn; then?: Turn }[] = [],
) {
  const id = "members-scripted";
  const faux = fauxProvider({ provider: id, api: id, models: [{ id }] });
  const queue = [...turns];
  const used = new Set<string>();
  const seen: TranscriptContext[] = [];
  const next = (context: TranscriptContext): FauxResponseStep => {
    seen.push(context);
    const text = userTextOf(context);
    let turn: Turn | undefined;
    for (const entry of byMarker) {
      if (!text.includes(entry.marker)) continue;
      turn = used.has(entry.marker) ? entry.then : entry.turn;
      used.add(entry.marker);
      break;
    }
    turn ??= queue.shift() ?? { text: "done" };
    return fauxAssistantMessage(
      [
        ...(turn.text === undefined ? [] : [fauxText(turn.text)]),
        ...(turn.toolCalls ?? []).map((call) =>
          fauxToolCall(call.name, call.args as ToolCall["arguments"]),
        ),
      ],
      { stopReason: turn.toolCalls?.length ? "toolUse" : "stop" },
    );
  };
  const provider: Provider = {
    ...faux.provider,
    stream: (model, context, options) => {
      faux.setResponses([next(context)]);
      return faux.provider.stream(model, context, options);
    },
    streamSimple: (model, context, options) => {
      faux.setResponses([next(context)]);
      return faux.provider.streamSimple(model, context, options);
    },
  };
  registerTestProvider(provider);
  return { ref: { provider: id, id }, seen };
}

function systemText(context: TranscriptContext | undefined): string {
  const shown = new Map<string, string>();
  for (const entry of context?.messages ?? []) {
    if (entry.role !== "system") continue;
    const sections = (entry as { sections?: Record<string, string | null> }).sections;
    if (sections === undefined) continue;
    for (const [key, value] of Object.entries(sections)) {
      if (value === null) shown.delete(key);
      else shown.set(key, value);
    }
  }
  return [...shown.values()].join("\n\n");
}

/** The tool names this Butler instance has installed. */
function installedTools(stub: ReturnType<typeof butler>): Promise<string[]> {
  return runInDurableObject(stub, (instance) =>
    (instance as unknown as { registry: { snapshot(): { tools(): { tool: { name: string } }[] } } })
      .registry.snapshot()
      .tools()
      .map(({ tool }) => tool.name),
  );
}

const allPrompts = (seen: TranscriptContext[]): string =>
  seen.map((context) => systemText(context)).join("\n");

/** The system prompt of the request that carried `marker` as user text. */
function promptFor(seen: TranscriptContext[], marker: string): string {
  const hit = seen.filter((context) =>
    context.messages.some(
      (entry) =>
        entry.role === "user" &&
        (typeof entry.content === "string"
          ? entry.content.includes(marker)
          : JSON.stringify(entry.content).includes(marker)),
    ),
  );
  expect(hit.length).toBeGreaterThan(0);
  return allPrompts(hit);
}

/** An active member plus its connection, created through the real directory. */
let bindingSeq = 0;

async function activeMember(
  label: string,
  binding = memberBinding,
): Promise<{ memberId: string; actor: { memberId: string; role: "member"; epoch: number } }> {
  const stub = channels();
  return runInDurableObject(stub, (instance, state) => {
    const store = new MemberStore(state.storage.sql, undefined, (fn) =>
      state.storage.transactionSync(fn),
    );
    store.ensureOwner();
    // A fixture DO may boot with pre-members tables: settle the inbox decision
    // so activation is allowed, exactly as a migrated deployment would.
    state.storage.sql.exec(
      `INSERT INTO member_migrations (name, cursor, done, updated_at)
       VALUES ('legacy-inbox-owner', NULL, 1, 1)
       ON CONFLICT(name) DO UPDATE SET done = 1`,
    );
    const invite = store.createInvite(label);
    bindingSeq += 1;
    const unique = {
      ...binding,
      connectionId: `${binding.connectionId}-${bindingSeq}`,
      credentialKey: `${binding.credentialKey}-${bindingSeq}`,
      accountId: `wx-${label}-${bindingSeq}`,
      userId: `user-${label}-${bindingSeq}`,
    };
    const member = store.completeInvite(invite.inviteId, unique);
    const principal = store.principal(member.memberId);
    if (!principal) throw new Error("member missing");
    void instance;
    return {
      memberId: member.memberId,
      actor: { memberId: member.memberId, role: "member", epoch: principal.epoch },
    };
  });
}

/**
 * A message from a member's own WeChat connection: the real member route and
 * the real connection row, which is what the receiving side validates.
 */
async function memberMessage(
  actor: { memberId: string; role: "member"; epoch: number },
  eventId: string,
): Promise<AdmittedMessage> {
  const hub = channels();
  const memberRoute = await hub.routeForMember(actor);
  const connection = await runInDurableObject(hub, (_instance, state) => {
    void _instance;
    return state.storage.sql
      .exec<{ id: string; generation: number }>(
        `SELECT id, generation FROM member_connections WHERE member_id = ?`,
        actor.memberId,
      )
      .toArray()[0];
  });
  if (connection === undefined) throw new Error("fixture: no connection");
  return {
    type: "message",
    channel: "wechat",
    chatId: "m-chat",
    userId: "m-user",
    text: `hello ${eventId}`,
    eventId,
    routeKey: memberRoute.routeKey,
    actor,
    connectionRef: {
      memberId: actor.memberId,
      connectionId: connection.id,
      generation: connection.generation,
    },
  };
}

async function initMember(
  memberId: string,
  actor: { memberId: string; role: "member"; epoch: number },
): Promise<void> {
  await butler(butlerName(memberId)).initializeMember(actor);
}

beforeEach(async () => {
  await seedOwnerAddress("42");
  const channel = fakeChannel();
  setChannelOverride("telegram", channel.adapter);
  route = await channels().currentRoute();
});

afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
  setChannelOverride("wechat", null);
});

describe("per-member butler isolation", () => {
  it("member object refuses business before initialization", async () => {
    const { ref, seen } = scripted([{ text: "should not run" }]);
    setModelOverride(ref);
    const { memberId, actor } = await activeMember("未初始化");
    const stub = butler(butlerName(memberId));
    await stub.handleMessage((await memberMessage(actor, "uninit-1")));
    // Nothing ran: no model request, no tools, no task.
    expect(seen).toHaveLength(0);
    expect(await installedTools(stub)).toHaveLength(0);
  });

  it("initialization cannot move a member object to another identity", async () => {
    const { ref } = scripted([{ text: "ok" }]);
    setModelOverride(ref);
    const { memberId } = await activeMember("A");
    const other = await activeMember("B", {
      ...memberBinding,
      connectionId: "c-b",
      credentialKey: "credential-b-op1",
      accountId: "wx-b",
      userId: "user-b",
      credentialHash: "fake-b-hash",
    });
    const stub = butler(butlerName(memberId));
    await stub.initializeMember({ memberId, role: "member", epoch: 1 });
    let denied = false;
    try {
      await stub.initializeMember(other.actor);
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
  });

  it("revoked member is denied on the next call", async () => {
    const { ref, seen } = scripted([{ text: "ok" }]);
    setModelOverride(ref);
    const { memberId, actor } = await activeMember("将撤销");
    const stub = butler(butlerName(memberId));
    await stub.initializeMember(actor);
    await runInDurableObject(channels(), (_instance, state) => {
      new MemberStore(state.storage.sql).revoke(memberId);
    });
    const before = seen.length;
    // A revoked member cannot even be addressed: the route lookup denies it,
    // which is the same fail-closed answer production produces.
    let denied = false;
    try {
      await memberMessage(actor, "revoked-1");
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    expect(seen.length).toBe(before);
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec(`SELECT id FROM tasks`).toArray(),
    );
    expect(rows).toEqual([]);
  });

  it("A, B and owner histories never reach each other", async () => {
    const { ref, seen } = scripted(
      [],
      [
        {
          marker: "只对我保密 OWNER_SECRET",
          turn: { text: "收下了", toolCalls: [{ name: "remember", args: { content: "OWNER_SECRET" } }] },
          then: { text: "记住了" },
        },
        {
          marker: "hello ascope-1",
          turn: { text: "收下了", toolCalls: [{ name: "remember", args: { content: "A_SECRET" } }] },
          then: { text: "A记住了" },
        },
        { marker: "hello bscope-1", turn: { text: "B询问" } },
        { marker: "再问一次", turn: { text: "owner又问" } },
      ],
    );
    setModelOverride(ref);
    const ownerStub = butler("owner");
    await ownerStub.handleMessage({
      type: "message",
      channel: "telegram",
      chatId: "42",
      userId: "1",
      text: "只对我保密 OWNER_SECRET",
      eventId: "ownerscope-1",
      routeKey: route.routeKey,
    });
    await ownerStub.handleMessage({
      type: "message",
      channel: "telegram",
      chatId: "42",
      userId: "1",
      text: "再问一次",
      eventId: "ownerscope-2",
      routeKey: route.routeKey,
    });

    const a = await activeMember("A");
    const b = await activeMember("B", {
      ...memberBinding,
      connectionId: "c-b",
      credentialKey: "credential-b-op1",
      accountId: "wx-b",
      userId: "user-b",
      credentialHash: "fake-b-hash",
    });
    const aStub = butler(butlerName(a.memberId));
    await initMember(a.memberId, a.actor);
    await aStub.handleMessage((await memberMessage(a.actor, "ascope-1")));
    await aStub.handleMessage((await memberMessage(a.actor, "ascope-2")));

    const bStub = butler(butlerName(b.memberId));
    await initMember(b.memberId, b.actor);
    await bStub.handleMessage((await memberMessage(b.actor, "bscope-1")));

    const bPrompt = promptFor(seen, "hello bscope-1");
    expect(bPrompt).not.toContain("OWNER_SECRET");
    expect(bPrompt).not.toContain("A_SECRET");
    const aPrompt = promptFor(seen, "hello ascope-1");
    expect(aPrompt).not.toContain("OWNER_SECRET");

    // A's remember landed in A's own memory, not B's or the owner's.
    await runInDurableObject(aStub, (instance) => {
      const memory = (instance as unknown as { memory: { search(k: string): unknown[] } }).memory;
      expect(JSON.stringify(memory.search("A_SECRET"))).toContain("A_SECRET");
    });
    await runInDurableObject(bStub, (instance) => {
      const memory = (instance as unknown as { memory: { search(k: string): unknown[] } }).memory;
      expect(memory.search("A_SECRET")).toEqual([]);
    });
  });

  it("member tools exclude bot, self and wallet surfaces", async () => {
    const { ref } = scripted([{ text: "hi" }]);
    setModelOverride(ref);
    const { memberId, actor } = await activeMember("工具");
    const stub = butler(butlerName(memberId));
    await initMember(memberId, actor);
    await stub.handleMessage((await memberMessage(actor, "tools-1")));
    const names = await installedTools(stub);
    expect(names).toContain("spawn_task");
    expect(names).toContain("remember");
    for (const denied of ["create_bot", "list_bots", "wake_self", "self_read", "wallet_status"]) {
      expect(names).not.toContain(denied);
    }
  });

  it("member task ids are namespaced and carry the member actor", async () => {
    const { ref } = scripted([], [
      {
        marker: "hello spawn-1",
        turn: { text: "开个任务", toolCalls: [{ name: "spawn_task", args: { title: "查资料", instructions: "查一下" } }] },
        then: { text: "已开始" },
      },
    ]);
    setModelOverride(ref);
    const { memberId, actor } = await activeMember("任务");
    const stub = butler(butlerName(memberId));
    await initMember(memberId, actor);
    await stub.handleMessage((await memberMessage(actor, "spawn-1")));
    const rows = await runInDurableObject(stub, (instance, state) => {
      void instance;
      return state.storage.sql
        .exec<{ id: string }>(`SELECT id FROM tasks`)
        .toArray();
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toMatch(/^m[0-9a-f]{32}-t\d+$/);
    expect(rows[0]!.id.startsWith(memberId)).toBe(true);
    const spec = await runInDurableObject(task(rows[0]!.id), (_instance, state) =>
      state.storage.sql
        .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'spec'`)
        .toArray(),
    );
    expect(JSON.stringify(spec)).toContain(memberId);
  });

  it("owner object keeps its identity and full tool set", async () => {
    const { ref } = scripted([{ text: "hi" }]);
    setModelOverride(ref);
    const stub = butler("owner");
    await stub.handleMessage({
      type: "message",
      channel: "telegram",
      chatId: "42",
      userId: "1",
      text: "owner",
      eventId: "owner-tools-1",
      routeKey: route.routeKey,
    });
    const names = await installedTools(stub);
    expect(names).toContain("create_bot");
    await runInDurableObject(stub, async (instance) => {
      const principal = await (instance as unknown as { ensurePrincipal(): Promise<{ memberId: string }> }).ensurePrincipal();
      expect(principal.memberId).toBe(OWNER_ID);
    });
    expect(ownerPrincipal().role).toBe("owner");
  });
});
