import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import { memberBinding } from "../helpers/members";
import { MemberStore } from "../../src/members/store";
import { ownerPrincipal } from "../../src/members/principal";
import type { Principal } from "../../src/members/principal";
import type { TaskSpec } from "../../src/protocol";
import { memberArtifactStore, memberTaskTools } from "../../src/task/member-tools";
import { saveModelCredential } from "../../src/llm/model-auth";
import { fakeCodexToken } from "../helpers/codex-token";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** Tools a member task may use: nothing that reaches the network or a shell. */
const MEMBER_ALLOWED = [
  "web_search",
  "now",
  "get_artifact",
  "save_artifact",
  "read",
  "write",
  "edit",
  "list",
  "finish_task",
];

const MEMBER_DENIED = [
  "http_request",
  "web_fetch",
  "sandbox_run",
  "sandbox_put",
  "sandbox_get",
  "mail_inbox",
  "mail_read",
  "codemode",
  "tool_search",
  "mcp_call",
  "bot_notify",
];

type TaskStub = ReturnType<typeof taskStub>;

function taskStub(taskId: string) {
  return env.TASK.get(env.TASK.idFromName(taskId));
}

function channels() {
  return env.CHANNELS.get(env.CHANNELS.idFromName("channels"));
}

function installedTools(stub: TaskStub): Promise<string[]> {
  return runInDurableObject(stub, (instance) =>
    instance.registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool.name),
  );
}

/** Runs an installed tool directly, exactly as a model tool call would. */
function runTool(
  stub: TaskStub,
  name: string,
  args: unknown,
): Promise<{ text: string; isError: boolean }> {
  return runInDurableObject(stub, async (instance) => {
    const entry = instance.registry
      .snapshot()
      .tools()
      .find(({ tool }) => tool.name === name);
    if (entry === undefined) throw new Error(`missing tool ${name}`);
    const outcome = await entry.tool.execute(args as never, {} as never, {} as never);
    const first = outcome.output?.[0] as { text?: string } | undefined;
    return { text: first?.text ?? "", isError: outcome.isError === true };
  });
}

let memberSeq = 0;

/** An active member plus its connection, created through the real directory. */
async function activeMember(label: string): Promise<Principal> {
  memberSeq += 1;
  const unique = `-${label}-${memberSeq}`;
  return runInDurableObject(channels(), (instance, state) => {
    void instance;
    const store = new MemberStore(state.storage.sql, undefined, (fn) =>
      state.storage.transactionSync(fn),
    );
    store.ensureOwner();
    state.storage.sql.exec(
      `INSERT INTO member_migrations (name, cursor, done, updated_at)
       VALUES ('legacy-inbox-owner', NULL, 1, 1)
       ON CONFLICT(name) DO UPDATE SET done = 1`,
    );
    const invite = store.createInvite(label);
    const member = store.completeInvite(invite.inviteId, {
      ...memberBinding,
      connectionId: `${memberBinding.connectionId}${unique}`,
      credentialKey: `${memberBinding.credentialKey}${unique}`,
      accountId: `wx${unique}`,
      userId: `user${unique}`,
    });
    const stored = store.principal(member.memberId);
    if (stored === null) throw new Error("member missing");
    return { memberId: member.memberId, role: "member" as const, epoch: stored.epoch };
  });
}

function memberSpec(taskId: string, actor: Principal): TaskSpec {
  return {
    taskId,
    title: `Member task ${taskId}`,
    instructions: "summarize the news",
    actor,
  };
}

beforeEach(() => {
  setChannelOverride("telegram", fakeChannel().adapter);
});

afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("member task execution profile", () => {
  it("installs only the member tool set", async () => {
    setModelOverride(scriptedModel([{ text: "done" }]));
    const actor = await activeMember("tools");
    const taskId = `${actor.memberId}-t1`;
    const stub = taskStub(taskId);

    await stub.start(memberSpec(taskId, actor));

    const names = await installedTools(stub);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set(MEMBER_ALLOWED));
    for (const denied of MEMBER_DENIED) expect(names).not.toContain(denied);
  });

  it("keeps the owner suite for an owner task", async () => {
    setModelOverride(scriptedModel([{ text: "done" }]));
    const stub = taskStub("t-members-owner-suite");

    await stub.start({
      taskId: "t-members-owner-suite",
      title: "Owner task",
      instructions: "do the thing",
      actor: ownerPrincipal(),
    });

    const names = await installedTools(stub);
    expect(names).toEqual(expect.arrayContaining(["http_request", "web_fetch", "finish_task"]));
    expect(names).toEqual(expect.arrayContaining(MEMBER_ALLOWED));
  });

  it("keeps the restrictions when the profile is re-installed after recovery", async () => {
    setModelOverride(scriptedModel([{ text: "done" }]));
    const actor = await activeMember("recovery");
    const taskId = `${actor.memberId}-t1`;
    const stub = taskStub(taskId);

    await stub.start(memberSpec(taskId, actor));
    const again = await runInDurableObject(stub, (instance) =>
      instance.ensureExecutionProfile(),
    );

    expect(again).toBe("member");
    const names = await installedTools(stub);
    expect(new Set(names)).toEqual(new Set(MEMBER_ALLOWED));
    expect(names).not.toContain("http_request");
  });
});

describe("member tool guards", () => {
  async function memberTask(label: string): Promise<{ stub: TaskStub; taskId: string; actor: Principal }> {
    setModelOverride(scriptedModel([{ text: "done" }]));
    const actor = await activeMember(label);
    const taskId = `${actor.memberId}-t1`;
    const stub = taskStub(taskId);
    await stub.start(memberSpec(taskId, actor));
    return { stub, taskId, actor };
  }

  it("rejects any save_artifact url field", async () => {
    const { stub } = await memberTask("save-url");

    const result = await runTool(stub, "save_artifact", {
      url: "https://example.com/report.pdf",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("url");
  });

  it("keeps inline save_artifact working inside the task prefix", async () => {
    const { stub, taskId } = await memberTask("save-inline");

    const saved = await runTool(stub, "save_artifact", {
      filename: "notes.txt",
      content: "hello",
    });

    expect(saved.isError).toBe(false);
    const page = await env.ARTIFACTS.list({ prefix: `${taskId}/` });
    expect(page.objects.map((object) => object.key)).toHaveLength(1);
  });

  it("rejects get_artifact references outside the task", async () => {
    const { stub } = await memberTask("get-outside");
    await env.ARTIFACTS.put("t-someone-else/abc/secret.txt", "theirs");

    const result = await runTool(stub, "get_artifact", {
      ref: "t-someone-else/abc/secret.txt",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("无权读取");
  });

  it("cannot read or list the shared skill library", async () => {
    const { stub } = await memberTask("skills");
    await env.ARTIFACTS.put("skills/demo/SKILL.md", "owner-only instructions");

    const read = await runTool(stub, "read", { path: "/skills/demo/SKILL.md" });
    const listed = await runTool(stub, "list", { path: "/skills" });

    expect(read.isError).toBe(true);
    expect(listed.text).not.toContain("SKILL.md");
  });
});

describe("memberArtifactStore", () => {
  it("allows only the task's own keys and its attachments", async () => {
    const taskId = "m-attach-scope-t1";
    await env.ARTIFACTS.put(`${taskId}/a/own.txt`, "own");
    await env.ARTIFACTS.put(`work/${taskId}/draft.txt`, "draft");
    await env.ARTIFACTS.put("inbox/x/attached.pdf", "attached");
    await env.ARTIFACTS.put("skills/demo/SKILL.md", "shared");
    await env.ARTIFACTS.put("t-other/b/other.txt", "other");

    const store = memberArtifactStore(env.ARTIFACTS, {
      taskId: () => taskId,
      attachments: () => ["inbox/x/attached.pdf"],
    });

    expect(await store.get(`${taskId}/a/own.txt`)).not.toBeNull();
    expect(await store.get(`work/${taskId}/draft.txt`)).not.toBeNull();
    expect(await store.get("inbox/x/attached.pdf")).not.toBeNull();
    expect(await store.head("skills/demo/SKILL.md")).toBeNull();
    expect(await store.get("t-other/b/other.txt")).toBeNull();
    expect(await store.get("inbox/y/nope.pdf")).toBeNull();

    const skills = await store.list({ prefix: "skills/" });
    expect(skills.objects).toHaveLength(0);
    const everything = await store.list();
    expect(everything.objects.map((object) => object.key).sort()).toEqual([
      "inbox/x/attached.pdf",
      `${taskId}/a/own.txt`,
      `work/${taskId}/draft.txt`,
    ]);

    await expect(store.put("skills/hack/SKILL.md", "x")).rejects.toThrow();
    await expect(store.delete("t-other/b/other.txt")).rejects.toThrow();
    await store.delete(`${taskId}/a/own.txt`);
    expect(await store.get(`${taskId}/a/own.txt`)).toBeNull();
  });
});

describe("member task control", () => {
  it("denies control from an actor that does not match the spec", async () => {
    setModelOverride(scriptedModel([{ text: "done" }]));
    const actor = await activeMember("control");
    const taskId = `${actor.memberId}-t1`;
    const stub = taskStub(taskId);
    await stub.start(memberSpec(taskId, actor));

    const status = await stub.status(ownerPrincipal());
    expect(status.denied).toBe(true);

    const steered = await stub.steer("another instruction", ownerPrincipal());
    expect(steered.ok).toBe(false);

    const cancelled = await stub.cancel(ownerPrincipal());
    expect(cancelled.ok).toBe(false);
    expect((await stub.status(actor)).state).not.toBe("cancelled");

    expect(await stub.pendingApprovals(ownerPrincipal())).toEqual([]);
  });

  it("accepts control from the task's own actor", async () => {
    setModelOverride(
      scriptedModel([
        { toolCalls: [{ name: "finish_task", args: { summary: "done", artifacts: [] } }] },
      ]),
    );
    const actor = await activeMember("control-own");
    const taskId = `${actor.memberId}-t1`;
    const stub = taskStub(taskId);
    await stub.start(memberSpec(taskId, actor));

    await vi.waitFor(async () => {
      expect((await stub.status(actor)).state).toBe("completed");
    });
    expect((await stub.status(actor)).denied).toBeUndefined();

    const denied = await stub.continueTask("more", ownerPrincipal());
    expect(denied.ok).toBe(false);
    expect((await stub.status(ownerPrincipal())).denied).toBe(true);
  });

  it("treats a legacy actor-less tN task as owner-only", async () => {
    setModelOverride(scriptedModel([{ text: "done" }]));
    const stub = taskStub("t990001");
    await stub.start({
      taskId: "t990001",
      title: "Legacy task",
      instructions: "do the thing",
    });

    expect((await stub.status()).denied).toBeUndefined();
    const actor = await activeMember("legacy");
    expect((await stub.status(actor)).denied).toBe(true);
  });
});

/**
 * The suite runs a scripted model, so this checks the wiring directly: the
 * tool must ask for the task's model instead of assuming a provider.
 */
describe("web_search model wiring", () => {
  it("passes the task's model through to the search tool", async () => {
    await saveModelCredential(env, "openai-codex", {
      type: "oauth",
      access: fakeCodexToken(),
      refresh: "refresh-0",
      expires: Date.now() + 3_600_000,
    });

    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const host = new URL(String(input)).host;
      hosts.push(host);
      if (host !== "chatgpt.com") throw new Error(`unexpected host: ${host}`);
      const event = {
        type: "response.output_item.done",
        item: {
          type: "message",
          content: [{ type: "output_text", text: "订阅搜索的结果" }],
        },
      };
      return new Response(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const tool = memberTaskTools({
      env,
      taskId: () => "",
      attachments: () => [],
      store: {} as never,
      finish: {} as never,
      currentModel: () => ({ provider: "openai-codex", id: "gpt-6.2-sol" }),
    }).find((item) => item.name === "web_search");
    if (tool === undefined) throw new Error("web_search is not installed");

    const result = await tool.execute(
      { query: "q" },
      {} as never,
      { abortSignal: new AbortController().signal } as never,
    );

    expect(hosts).toEqual(["chatgpt.com"]);
    expect(JSON.stringify(result)).toContain("订阅搜索的结果");
  });
});

describe("teen member task prompt", () => {
  it("carries the minor boundary into the running task", async () => {
    const actor = await activeMember("teen-task");
    await runInDurableObject(channels(), (_instance, state) => {
      new MemberStore(state.storage.sql).setTeen(actor.memberId, true);
    });

    let seen = "";
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [{ name: "finish_task", args: { summary: "ok" } }],
          observe: (context) => {
            seen = JSON.stringify(context.messages);
          },
        },
      ]),
    );
    const taskId = `${actor.memberId}-t1`;
    const stub = taskStub(taskId);
    await stub.start(memberSpec(taskId, actor));

    // The run continues after start(); wait for the request it makes, then
    // for the run to settle so nothing logs after the file ends.
    await vi.waitFor(() => {
      expect(seen).toContain(
        "The person behind this task is a minor (under 18).",
      );
    });
    await vi.waitFor(async () => {
      expect((await stub.status()).state).toBe("completed");
    });
  });

  it("leaves an unflagged member's task alone", async () => {
    const actor = await activeMember("plain-task");
    let seen = "";
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [{ name: "finish_task", args: { summary: "ok" } }],
          observe: (context) => {
            seen = JSON.stringify(context.messages);
          },
        },
      ]),
    );
    const taskId = `${actor.memberId}-t1`;
    const stub = taskStub(taskId);
    await stub.start(memberSpec(taskId, actor));

    await vi.waitFor(() => {
      expect(seen).not.toBe("");
    });
    expect(seen).not.toContain("minor (under 18)");
    await vi.waitFor(async () => {
      expect((await stub.status()).state).toBe("completed");
    });
  });
});

describe("minor flag across rounds", () => {
  it("re-reads the directory before a follow-up round", async () => {
    const actor = await activeMember("teen-followup");
    const taskId = `${actor.memberId}-t1`;
    const turn = {
      toolCalls: [{ name: "finish_task", args: { summary: "ok" } }],
    };
    setModelOverride(scriptedModel([turn, turn, turn]));
    const stub = taskStub(taskId);
    await stub.start(memberSpec(taskId, actor));
    await vi.waitFor(async () => {
      expect((await stub.status()).state).toBe("completed");
    });

    await runInDurableObject(channels(), (_instance, state) => {
      new MemberStore(state.storage.sql).setTeen(actor.memberId, true);
    });

    const followed = await stub.continueTask("再来一次", actor);
    expect(followed.ok).toBe(true);

    // The prompt the next round will send, rendered from the live registry.
    const section = await runInDurableObject(stub, async (instance) => {
      const extension = instance.registry.snapshot().extension("task");
      const found = extension?.sections?.find((entry) => entry.key === "task");
      if (!found) throw new Error("fixture: task section missing");
      return (await found.render({} as never, {} as never)) ?? "";
    });
    expect(section).toContain("The person behind this task is a minor");
    await vi.waitFor(async () => {
      expect((await stub.status()).state).toBe("completed");
    });
  });
});
