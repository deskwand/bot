import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TasksRepo, taskLabel } from "../../src/butler/tasks-repo";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function butler(name: string) {
  return env.BUTLER.get(env.BUTLER.idFromName(name));
}

function withRepo<T>(
  name: string,
  fn: (repo: TasksRepo) => T,
): Promise<T> {
  return runInDurableObject(butler(name), (_instance, state) =>
    fn(new TasksRepo(state.storage.sql)),
  );
}

describe("TasksRepo handles", () => {
  it("assigns the smallest free handle among active owner tasks", async () => {
    const handles = await withRepo("handles-smallest", (repo) => {
      repo.insert({ id: "t1", title: "a", chatId: null });
      repo.insert({ id: "t2", title: "b", chatId: null });
      const first = [repo.get("t1")?.handle, repo.get("t2")?.handle];

      repo.update("t1", { status: "completed" });
      repo.insert({ id: "t3", title: "c", chatId: null });
      repo.insert({ id: "t4", title: "d", chatId: null });
      return [...first, repo.get("t3")?.handle, repo.get("t4")?.handle];
    });

    expect(handles).toEqual([1, 2, 1, 3]);
  });

  it("fills a gap: with 1 and 3 active the next task gets 2", async () => {
    const handle = await withRepo("handles-gap", (repo) => {
      repo.insert({ id: "t1", title: "a", chatId: null });
      repo.insert({ id: "t2", title: "b", chatId: null });
      repo.insert({ id: "t3", title: "c", chatId: null });
      repo.update("t2", { status: "completed" });

      repo.insert({ id: "t4", title: "d", chatId: null });
      return repo.get("t4")?.handle;
    });

    expect(handle).toBe(2);
  });

  it("gives bot tasks no handle and does not count them", async () => {
    const handles = await withRepo("handles-bot", (repo) => {
      repo.insert({ id: "b1", title: "bot", chatId: null, botId: "b" });
      repo.insert({ id: "t1", title: "owner", chatId: null });
      repo.insert({ id: "t2", title: "owner", chatId: null });
      return [repo.get("b1")?.handle, repo.get("t1")?.handle, repo.get("t2")?.handle];
    });

    expect(handles).toEqual([null, 1, 2]);
  });

  it("finds only active owner tasks by handle", async () => {
    const found = await withRepo("handles-find", (repo) => {
      repo.insert({ id: "t1", title: "a", chatId: null });
      repo.update("t1", { status: "completed" });
      repo.insert({ id: "t2", title: "b", chatId: null });
      return [
        repo.findActiveByHandle(1)?.id,
        repo.findActiveByHandle(9),
      ];
    });

    expect(found).toEqual(["t2", null]);
  });

  it("labels rows with and without a handle", () => {
    expect(taskLabel({ id: "t61", handle: 2 })).toBe("#2");
    expect(taskLabel({ id: "t61", handle: null })).toBe("t61");
  });

  it("skips the handle for a placeholder row", async () => {
    const handle = await withRepo("handles-placeholder", (repo) => {
      repo.insert({ id: "t9", title: "", chatId: null, handle: false });
      return repo.get("t9")?.handle;
    });

    expect(handle).toBeNull();
  });

  it("re-assigns a stale handle when a failed task restarts", async () => {
    const state = await withRepo("handles-restart", (repo) => {
      repo.insert({ id: "t1", title: "a", chatId: null });
      repo.update("t1", { status: "failed" });
      repo.insert({ id: "t2", title: "b", chatId: null });

      repo.update("t1", { status: "running" });
      repo.ensureHandle("t1");
      repo.ensureHandle("t2");

      repo.insert({ id: "b1", title: "bot", chatId: null, botId: "b" });
      repo.ensureHandle("b1");

      return {
        t1: repo.get("t1")?.handle,
        t2: repo.get("t2")?.handle,
        b1: repo.get("b1")?.handle,
      };
    });

    expect(state).toEqual({ t1: 2, t2: 1, b1: null });
  });
});

describe("TasksRepo artifacts", () => {
  it("converts legacy artifact URLs into keys and drops junk", async () => {
    const artifacts = await runInDurableObject(
      butler("artifacts-legacy"),
      (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO tasks
             (id, title, status, created_at, updated_at, chat_id, artifacts_json, last_seq)
           VALUES ('t1', 'a', 'completed', 0, 0, NULL, ?, 0)`,
          JSON.stringify([
            { name: "a.md", url: "https://example.com/a/t1/f1/a.md" },
            { name: "b.md", url: "not a url" },
            { name: "c.md", key: "t1/f2/c.md" },
          ]),
        );
        return new TasksRepo(state.storage.sql).get("t1")?.artifacts;
      },
    );

    expect(artifacts).toEqual([
      { name: "a.md", key: "t1/f1/a.md" },
      { name: "c.md", key: "t1/f2/c.md" },
    ]);
  });
});
