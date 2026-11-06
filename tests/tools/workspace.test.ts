import type { Context } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ImageLimits, ImageProcessor } from "@earendil-works/pi-durable/tools";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { INBOUND_IMAGE_LIMITS } from "../../src/channels/media";
import { MAX_DRAFT_BYTES, createR2WorkspaceEnv } from "../../src/env/r2-env";
import { clearWorkspace, workspaceTools } from "../../src/tools/workspace";
import { PNG_B64, bytes } from "../helpers/images";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const ctx = { abortSignal: undefined } as unknown as Context;

function abortedContext(): Context {
  const controller = new AbortController();
  controller.abort();
  return { abortSignal: controller.signal } as unknown as Context;
}

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

const apiFor = (taskId: string) => ({
  env: createR2WorkspaceEnv(env.ARTIFACTS, taskId),
  agent: async () => ({ model: undefined }),
  models: { getModel: () => undefined },
}) as never;

const tool = (name: string, taskId = "t1") =>
  workspaceTools(env.ARTIFACTS, () => taskId).find((t) => t.name === name)!;

describe("workspaceTools", () => {
  it("writes, edits and reads a draft", async () => {
    await tool("write").execute({ path: "draft.md", content: "# 标题\n旧段落\n" }, apiFor("t1"), ctx);
    const edited = await tool("edit").execute(
      { path: "draft.md", edits: [{ oldText: "旧段落", newText: "新段落" }] },
      apiFor("t1"),
      ctx,
    );
    expect(edited.isError).toBeFalsy();
    expect(textOf(await tool("read").execute({ path: "draft.md" }, apiFor("t1"), ctx))).toContain(
      "新段落",
    );
  });

  it("reads a slice of lines with offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `第${i + 1}行`).join("\n");
    await tool("write").execute({ path: "l.md", content: lines }, apiFor("t1"), ctx);
    const text = textOf(
      await tool("read").execute({ path: "l.md", offset: 4, limit: 2 }, apiFor("t1"), ctx),
    );
    expect(text).toContain("第4行");
    expect(text).toContain("第5行");
    expect(text).not.toContain("第6行");
  });

  it("refuses a draft over 1 MB and keeps the old one", async () => {
    await tool("write").execute({ path: "k.md", content: "旧" }, apiFor("t1"), ctx);
    const result = await tool("write").execute(
      { path: "k.md", content: "x".repeat(MAX_DRAFT_BYTES + 1) },
      apiFor("t1"),
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(await (await env.ARTIFACTS.get("work/t1/k.md"))!.text()).toBe("旧");
  });

  it("lists only this task's drafts", async () => {
    await env.ARTIFACTS.put("work/t1/a.md", "1");
    await env.ARTIFACTS.put("work/t2/b.md", "2");
    const text = textOf(await tool("list", "t1").execute({}, apiFor("t1"), ctx));
    expect(text).toContain("a.md");
    expect(text).not.toContain("b.md");
  });

  it("says the workspace is empty", async () => {
    expect(textOf(await tool("list", "t9").execute({}, apiFor("t9"), ctx))).toBe("草稿区为空");
  });

  it("marks the pi tools as workspace tools", () => {
    for (const name of ["read", "write", "edit", "list"]) {
      expect(tool(name).description).toContain("workspace");
    }
  });

  it("tells the model to use get_artifact for inbox files", async () => {
    const result = await tool("read").execute({ path: "inbox/tg:1/a.pdf" }, apiFor("t1"), ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("get_artifact");
  });

  it("rethrows a tool error when the caller aborted", async () => {
    await expect(
      tool("read").execute({ path: "inbox/tg:1/a.pdf" }, apiFor("t1"), abortedContext()),
    ).rejects.toThrow("get_artifact");
  });

  it("rethrows an AbortError even when the signal is not aborted", async () => {
    const api = {
      env: {
        absolutePath: async () => ({
          ok: false,
          error: new DOMException("aborted", "AbortError"),
        }),
      },
      agent: async () => ({ model: undefined }),
      models: { getModel: () => undefined },
    } as never;

    await expect(
      tool("read").execute({ path: "draft.md" }, api, ctx),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("clips image preparation to the inbound image limits", async () => {
    await env.ARTIFACTS.put("work/t1/pic.png", bytes(PNG_B64), {
      httpMetadata: { contentType: "image/png" },
    });
    const seen: ImageLimits[] = [];
    const inner: ImageProcessor = {
      async prepare(_bytes, _mimeType, limits) {
        seen.push(limits);
        return { data: "AAAA", mimeType: "image/png" };
      },
    };
    const api = {
      env: createR2WorkspaceEnv(env.ARTIFACTS, "t1"),
      agent: async () => ({ model: { provider: "p", modelId: "m" } }),
      models: {
        getModel: () => ({
          input: ["text", "image"],
          inputLimits: {
            images: {
              resize: { maxWidth: 5000, maxHeight: 4000, maxBytes: 10 * 1024 * 1024 },
            },
          },
        }),
      },
    } as never;

    const read = workspaceTools(env.ARTIFACTS, () => "t1", inner).find(
      (candidate) => candidate.name === "read",
    )!;
    await read.execute({ path: "pic.png" }, api, ctx);

    expect(seen).toEqual([INBOUND_IMAGE_LIMITS]);
  });
});

describe("clearWorkspace", () => {
  it("clears one task's drafts", async () => {
    await env.ARTIFACTS.put("work/t5/a.md", "1");
    await env.ARTIFACTS.put("work/t5/sub/b.md", "2");
    await env.ARTIFACTS.put("work/t6/c.md", "3");
    expect(await clearWorkspace(env.ARTIFACTS, "t5")).toBe(2);
    expect((await env.ARTIFACTS.list({ prefix: "work/t5/" })).objects).toHaveLength(0);
    expect(await env.ARTIFACTS.head("work/t6/c.md")).not.toBeNull();
  });
});
