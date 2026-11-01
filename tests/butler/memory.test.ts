import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MemoryStore, renderMemorySection } from "../../src/butler/memory";
import type { ButlerDO } from "../../src/butler/butler-do";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

async function runTool(
  instance: ButlerDO,
  name: string,
  args: unknown,
): Promise<string> {
  const entry = instance.registry
    .snapshot()
    .tools()
    .find(({ tool }) => tool.name === name);
  if (!entry) throw new Error(`missing tool ${name}`);
  const outcome = await entry.tool.execute(
    args as never,
    {} as never,
    {} as never,
  );
  return (outcome.output?.[0] as { text: string }).text;
}

describe("MemoryStore", () => {
  it("stores memories and finds them by keyword", async () => {
    const result = await runInDurableObject(butler("memory-search"), (_i, state) => {
      const store = new MemoryStore(state.storage.sql);
      const coffee = store.add("主人喜欢喝美式咖啡");
      store.add("主人住在上海");
      return { coffee, hits: store.search("咖啡"), all: store.all() };
    });

    expect(result.coffee).toBe(1);
    expect(result.hits).toEqual([
      { id: 1, content: "主人喜欢喝美式咖啡" },
    ]);
    expect(result.all.map((item) => item.id)).toEqual([1, 2]);
  });

  it("removes memories and reports unknown ids", async () => {
    const result = await runInDurableObject(
      butler("memory-remove"),
      (_i, state) => {
        const store = new MemoryStore(state.storage.sql);
        const id = store.add("主人不吃香菜");
        return {
          existing: store.remove(id),
          missing: store.remove(999),
          remaining: store.all(),
        };
      },
    );

    expect(result.existing).toBe(true);
    expect(result.missing).toBe(false);
    expect(result.remaining).toEqual([]);
  });

  it("renders an empty section when there are no memories", () => {
    expect(renderMemorySection([])).toBe("");
  });

  it("renders at most the latest 50 memories through the registry section", async () => {
    const rendered = await runInDurableObject(
      butler("memory-section"),
      async (instance, state) => {
        const store = new MemoryStore(state.storage.sql);
        for (let index = 1; index <= 60; index += 1) {
          store.add(`记忆 ${index}`);
        }
        const entry = instance.registry
          .snapshot()
          .sections()
          .find(({ section }) => section.key === "memory");
        if (!entry) throw new Error("missing memory section");
        return (await entry.section.render({} as never, {} as never)) ?? "";
      },
    );

    expect(rendered.startsWith("关于主人的已知信息：\n- 记忆 11")).toBe(true);
    expect(rendered).toContain("- 记忆 60");
    expect(rendered.match(/^- /gm)).toHaveLength(50);
  });

  it("answers remember, recall and forget through the butler tools", async () => {
    const result = await runInDurableObject(
      butler("memory-tools"),
      async (instance) => ({
        remembered: await runTool(instance, "remember", {
          content: "主人喜欢喝咖啡",
        }),
        hit: await runTool(instance, "recall", { keyword: "咖啡" }),
        miss: await runTool(instance, "recall", { keyword: "茶" }),
        forgotten: await runTool(instance, "forget", { id: 1 }),
        again: await runTool(instance, "forget", { id: 1 }),
      }),
    );

    expect(result).toEqual({
      remembered: "已记住 #1",
      hit: "#1 主人喜欢喝咖啡",
      miss: "没有相关记忆",
      forgotten: "已删除 #1",
      again: "没有记忆 #1",
    });
  });
});
