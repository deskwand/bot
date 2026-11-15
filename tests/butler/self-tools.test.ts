import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { SelfStore } from "../../src/butler/self-store";
import { createSelfTools } from "../../src/butler/self-tools";
import { createSelfSourceReader } from "../../src/butler/self-sources";
import { setModelOverride } from "../../src/llm/models";
import { scriptedModel } from "../helpers/scripted-model";
import { seedOwnerAddress } from "../helpers/channel-ref";
import { setChannelOverride } from "../../src/channels/override";
import { fakeChannel } from "../helpers/fake-channel";
const stub = (n: string) =>
  env.BUTLER.get(env.BUTLER.idFromName(`self-tools-${n}`));
const entry = (
  id: number,
  kind: string,
  model: unknown[],
  data?: EntryRecord["data"],
): EntryRecord => ({
  id: id as EntryRecord["id"],
  kind,
  ...(data === undefined ? {} : { data }),
  model: model as EntryRecord["model"],
  conversationId: 1 as EntryRecord["conversationId"],
});
afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
});
describe("self tools", () => {
  it("discovers typed real sources, excludes impostors and saves bounded host evidence", async () => {
    const reader = createSelfSourceReader({
      messages: async () => [
        entry(
          1,
          "butler.owner_message",
          [
            {
              role: "user",
              content: [{ type: "text", text: "owner says <<<hello>>>" }],
              timestamp: 1,
            },
          ],
          { ownerText: "owner says <<<hello>>>" },
        ),
        entry(5, "pi.user", [
          { role: "user", content: "unattributed legacy input", timestamp: 1 },
        ]),
        entry(2, "butler.self_wake", [
          { role: "user", content: "not owner", timestamp: 1 },
        ]),
        entry(3, "pi.tool-result", [
          {
            role: "toolResult",
            toolName: "quick_lookup",
            content: [{ type: "text", text: "result" }],
            isError: false,
          },
        ]),
        entry(4, "pi.tool-result", [
          {
            role: "toolResult",
            toolName: "quick_lookup",
            content: [{ type: "text", text: "failed" }],
            isError: true,
          },
        ]),
      ],
      tasks: () => [],
      botMessages: () => [
        {
          id: 5,
          kind: "bot.message",
          refId: "b1",
          at: 1,
          line: "bot reported",
        },
      ],
    });
    const sources = await reader.listSources();
    expect(sources.map((s) => s.ref)).toEqual(
      expect.arrayContaining(["entry:1", "entry:3", "ledger:5"]),
    );
    expect(sources).toHaveLength(3);
    expect(
      (await reader.resolveSource({ kind: "owner_message", ref: "entry:1" }))
        ?.excerpt,
    ).not.toContain("<<<");
    expect(
      await reader.resolveSource({ kind: "owner_message", ref: "entry:2" }),
    ).toBeNull();
    expect(
      await reader.resolveSource({ kind: "observation", ref: "entry:4" }),
    ).toBeNull();
    expect(await reader.resolveSource({ kind: "bot", ref: "b1" })).toBeNull();
  });
  it("enforces source attribution, time, CAS and preserved evidence after compaction", async () =>
    runInDurableObject(stub("execute"), async (_i, state) => {
      const store = new SelfStore(state.storage.sql);
      let available = true;
      const tools = createSelfTools({
        store,
        locale: "en",
        now: () => 100,
        listSources: async () => [],
        resolveSource: async (source) =>
          available ? { ...source, excerpt: "host result" } : null,
      });
      const call = async (name: string, args: unknown) => {
        const out = await tools
          .find((t) => t.name === name)!
          .execute(args as never, {} as never, {} as never);
        return JSON.parse((out.output![0] as { text: string }).text);
      };
      expect(tools.map((t) => t.name)).toEqual([
        "read_self",
        "write_self",
        "record_experience",
      ]);
      expect(
        await call("write_self", {
          kind: "identity",
          content: "test",
          expectedVersion: 0,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await call("write_self", {
          kind: "identity",
          content: "stale",
          expectedVersion: 0,
        }),
      ).toMatchObject({ reason: "conflict", current: { version: 1 } });
      const args = {
        expectedVersion: 0,
        facts: "observed",
        interpretation: "maybe",
        source: { kind: "task", ref: "t1" },
        occurredAt: 1,
      };
      expect(
        await call("record_experience", { ...args, occurredAt: 101 }),
      ).toMatchObject({ ok: false });
      const saved = await call("record_experience", args);
      expect(saved.value.source.excerpt).toBe("host result");
      available = false;
      expect(
        await call("record_experience", {
          ...args,
          id: saved.value.id,
          expectedVersion: 1,
          facts: "corrected",
        }),
      ).toMatchObject({ ok: true });
      expect(
        await call("record_experience", {
          ...args,
          source: { kind: "task", ref: "missing" },
        }),
      ).toMatchObject({ ok: false, reason: "source_unavailable" });
      expect(
        await call("record_experience", {
          ...args,
          source: { kind: "reflection", ref: null },
        }),
      ).toMatchObject({ ok: false });
      expect(
        await call("read_self", { kind: "experience", history: true }),
      ).toMatchObject({ ok: false, reason: "invalid" });
    }));
  for (const [n, args] of Object.entries({
    kind: { kind: "rules", content: "bad", expectedVersion: 0 },
    version: { kind: "identity", content: "bad" },
    extra: {
      kind: "identity",
      content: "bad",
      expectedVersion: 0,
      excerpt: "forged",
    },
  }))
    it(`rejects ${n} at the real Harness schema boundary`, async () => {
      let transcript = "";
      setChannelOverride("telegram", fakeChannel().adapter);
      await seedOwnerAddress();
      setModelOverride(
        scriptedModel([
          { toolCalls: [{ name: "write_self", args }] },
          {
            text: "done",
            observe: (c) => {
              transcript = JSON.stringify(c.messages);
            },
          },
        ]),
      );
      const route = await env.CHANNELS.get(
        env.CHANNELS.idFromName("channels"),
      ).currentRoute();
      await runInDurableObject(stub(n), async (i, s) => {
        const store = new SelfStore(s.storage.sql);
        const tools = createSelfTools({
          store,
          locale: "en",
          now: () => 100,
          listSources: async () => [],
          resolveSource: async () => null,
        });
        const execute = vi.spyOn(
          tools.find((tool) => tool.name === "write_self")!,
          "execute",
        );
        i.registry.install({ name: "test-self", tools });
        await i.handleMessage({
          type: "message",
          channel: "telegram",
          chatId: "42",
          userId: "1",
          text: "hello",
          eventId: `schema-${n}`,
          routeKey: route.routeKey,
        });
        expect(execute).not.toHaveBeenCalled();
        expect(store.doc("identity").version).toBe(0);
      });
      expect(transcript).toMatch(
        /invalid|validat|schema|unexpected|additional|union/i,
      );
    });
});

it("discovers owner, bot and successful lookup receipts through the live butler and records each", async () => {
  setChannelOverride("telegram", fakeChannel().adapter);
  await seedOwnerAddress();
  setModelOverride(
    scriptedModel([
      {
        toolCalls: [
          {
            name: "quick_lookup",
            args: { question: "test", queries: ["test"] },
          },
        ],
      },
      { text: "done" },
    ]),
  );
  const target = stub("live-sources");
  const route = await env.CHANNELS.get(
    env.CHANNELS.idFromName("channels"),
  ).currentRoute();
  await runInDurableObject(target, (i) => {
    // Replace only the external lookup execution; provenance still reads real committed Harness entries.
    const original = i.registry
      .snapshot()
      .tools()
      .find((e) => e.tool.name === "quick_lookup")!.tool;
    i.registry.install({
      name: "lookup-fixture",
      tools: [
        {
          ...original,
          execute: async () => ({
            output: [{ type: "text", text: "verified search receipt" }],
          }),
        },
      ],
    });
    i.ledger.add("bot.message", "bot1", "bot observed result", 1);
  });
  await target.handleMessage({
    type: "message",
    channel: "telegram",
    chatId: "42",
    userId: "1",
    text: "owner observed result",
    eventId: "tg:sources",
    routeKey: route.routeKey,
  });
  await runInDurableObject(target, async (i) => {
    const call = async (name: string, args: unknown) => {
      const tool = i.registry
        .snapshot()
        .tools()
        .find((e) => e.tool.name === name)!.tool;
      const r = await tool.execute(args as never, {} as never, {} as never);
      return JSON.parse((r.output![0] as { text: string }).text);
    };
    const discovered = await call("read_self", { kind: "sources" });
    for (const kind of ["owner_message", "bot", "observation"]) {
      const source = discovered.sources.find(
        (s: { kind: string }) => s.kind === kind,
      );
      expect(source).toBeDefined();
      const saved = await call("record_experience", {
        facts: `${kind} report`,
        interpretation: "attributed, not personal action",
        source: { kind, ref: source.ref },
        expectedVersion: 0,
        occurredAt: 1,
      });
      expect(saved.ok).toBe(true);
      expect(saved.value.source.excerpt).toContain(
        kind === "owner_message"
          ? "owner observed result"
          : kind === "bot"
            ? "bot observed result"
            : "verified search receipt",
      );
    }
  });
});

it("requires host-generated ids for new experiences and only revises existing ids", async () => {
  await runInDurableObject(stub("host-generated-id"), async (_i, s) => {
    const store = new SelfStore(s.storage.sql);
    const tools = createSelfTools({
      store,
      locale: "en",
      now: () => 100,
      listSources: async () => [],
      resolveSource: async (source) => ({ ...source, excerpt: "host result" }),
    });
    const record = tools.find((t) => t.name === "record_experience")!;
    const result = await record.execute(
      {
        id: "e" + "x".repeat(5000),
        expectedVersion: 0,
        facts: "event",
        interpretation: "interpretation",
        source: { kind: "task", ref: "t1" },
        occurredAt: 1,
      } as never,
      {} as never,
      {} as never,
    );
    expect(result.isError).toBe(true);
    expect(store.recentExperiences()).toEqual([]);
  });
});

async function selfCall(
  i: import("../../src/butler/butler-do").ButlerDO,
  name: string,
  args: unknown,
) {
  const tool = i.registry
    .snapshot()
    .tools()
    .find((t) => t.tool.name === name)!.tool;
  const result = await tool.execute(args as never, {} as never, {} as never);
  return JSON.parse((result.output![0] as { text: string }).text);
}

describe("review: provenance at real entrypoints", () => {
  it("attributes a bot report to its original receipt, not the spoken rewrite", async () => {
    const target = stub("real-bot-evidence");
    setChannelOverride("telegram", fakeChannel().adapter);
    await seedOwnerAddress();
    setModelOverride(scriptedModel([{ text: "spoken rewrite only" }]));
    await runInDurableObject(target, async (i, s) => {
      const { BotsRepo } = await import("../../src/butler/bots-repo");
      new BotsRepo(s.storage.sql).insert({
        id: "b-review",
        name: "research bot",
      });
    });
    expect(await target.notifyFromBot("b-review", "original bot result")).toBe(
      true,
    );
    await runInDurableObject(target, async (i) => {
      const source = (
        await selfCall(i, "read_self", { kind: "sources" })
      ).sources.find((s: { kind: string }) => s.kind === "bot");
      expect(source).toBeDefined();
      expect(source.excerpt).toBe("original bot result");
      const recorded = await selfCall(i, "record_experience", {
        expectedVersion: 0,
        facts: "the bot reported its result",
        interpretation: "not my personal action",
        source: { kind: "bot", ref: source.ref },
        occurredAt: 1,
      });
      expect(recorded.ok).toBe(true);
      expect(recorded.value.source.excerpt).toBe("original bot result");
      expect(i.ledger.pending().rows.map((r) => r.kind)).toEqual([
        "butler.said",
      ]);
    });
  });
  it("uses only original owner text when the submitted message has long host prefixes and quotes", async () => {
    const target = stub("original-owner-evidence");
    setChannelOverride("telegram", fakeChannel().adapter);
    await seedOwnerAddress();
    setModelOverride(scriptedModel([{ text: "done" }]));
    await runInDurableObject(target, (i) => {
      for (let n = 0; n < 8; n++)
        i.ledger.add(
          "butler.said",
          `notice-${n}`,
          "HOST GENERATED NOTICE " + "x".repeat(110),
          n,
        );
    });
    const route = await env.CHANNELS.get(
      env.CHANNELS.idFromName("channels"),
    ).currentRoute();
    await target.handleMessage({
      type: "message",
      channel: "telegram",
      chatId: "42",
      userId: "1",
      eventId: "tg:original-owner",
      routeKey: route.routeKey,
      text: "actual owner words",
      quotedText: "UNTRUSTED QUOTE " + "q".repeat(120),
    });
    await runInDurableObject(target, async (i) => {
      const source = (
        await selfCall(i, "read_self", { kind: "sources" })
      ).sources.find((s: { kind: string }) => s.kind === "owner_message");
      expect(source?.excerpt).toBe("actual owner words");
      const recorded = await selfCall(i, "record_experience", {
        expectedVersion: 0,
        facts: "the owner said actual owner words",
        interpretation: "attributed",
        source: { kind: "owner_message", ref: source.ref },
        occurredAt: 1,
      });
      expect(recorded.value.source.excerpt).toBe("actual owner words");
    });
  });
  it("retains the terminal failure reason for an ordinary owner task as source evidence", async () => {
    const target = stub("owner-failure-evidence");
    setChannelOverride("telegram", fakeChannel().adapter);
    await seedOwnerAddress();
    setModelOverride(scriptedModel([{ text: "report acknowledged" }]));
    await runInDurableObject(target, (_i, s) => {
      s.storage.sql.exec(
        "INSERT INTO tasks(id,title,status,created_at,updated_at,chat_id,artifacts_json,last_seq) VALUES('t-review','lookup','running',0,0,'42','[]',0)",
      );
    });
    await target.report({
      taskId: "t-review",
      seq: 1,
      type: "failed",
      reason: "network unavailable",
      retryable: true,
    });
    await runInDurableObject(target, async (i) => {
      const source = (
        await selfCall(i, "read_self", { kind: "sources" })
      ).sources.find(
        (s: { kind: string; ref: string }) =>
          s.kind === "task" && s.ref === "t-review",
      );
      expect(source?.excerpt).toBe("network unavailable");
      const recorded = await selfCall(i, "record_experience", {
        expectedVersion: 0,
        facts: "worker failed because the network was unavailable",
        interpretation: "do not assume completed",
        source: { kind: "task", ref: "t-review" },
        occurredAt: 1,
      });
      expect(recorded.ok).toBe(true);
      expect(recorded.value.source.excerpt).toBe("network unavailable");
    });
  });
});
