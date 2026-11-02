import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelOverride } from "../../src/channels/override";
import { setModelOverride } from "../../src/llm/models";
import { fakeChannel } from "../helpers/fake-channel";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

beforeEach(() => {
  setChannelOverride("telegram", fakeChannel().adapter);
});

afterEach(() => {
  setModelOverride(null);
  setChannelOverride("telegram", null);
});

function task(taskId: string) {
  return env.TASK.get(env.TASK.idFromName(taskId));
}

function piIndexes(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name LIKE 'pi\\_%' ESCAPE '\\'
         AND sql IS NOT NULL
       ORDER BY name`,
    )
    .toArray()
    .map((row) => row.name);
}

describe("TaskDO storage footprint", () => {
  it("runs pi without secondary indexes, which bill as extra rows written", async () => {
    setModelOverride(
      scriptedModel([
        {
          toolCalls: [
            {
              name: "save_artifact",
              args: { filename: "a.txt", content: "x" },
            },
          ],
        },
        { toolCalls: [{ name: "finish_task", args: { summary: "ok" } }] },
      ]),
    );
    const taskId = "t-footprint";
    const stub = task(taskId);

    await stub.start({ taskId, title: "Footprint", instructions: "go" });
    await vi.waitFor(
      async () => {
        expect((await stub.status()).state).toBe("completed");
      },
      { timeout: 10_000 },
    );

    const indexes = await runInDurableObject(stub, (_instance, state) =>
      piIndexes(state.storage.sql),
    );
    expect(indexes).toEqual([]);
  });
});
