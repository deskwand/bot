import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ButlerDO } from "../src/butler/butler-do";
import { RuntimeConfigError } from "../src/runtime-config";
import { TaskDO } from "../src/task/task-do";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function withoutConfig(): Env {
  return {
    ...(env as unknown as Env),
    DESKWAND_CONFIG: undefined,
  } as Env;
}

type CapturedError = { isRuntimeConfigError: boolean; code?: string };

async function captureError(run: () => Promise<unknown>): Promise<CapturedError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  return {
    isRuntimeConfigError: caught instanceof RuntimeConfigError,
    ...(caught instanceof RuntimeConfigError ? { code: caught.code } : {}),
  };
}

type ButlerModelPath = { ensureModel(): Promise<void> };
type TaskMcpPath = { ensureMcpTools(): Promise<void> };

describe("Durable Objects without DESKWAND_CONFIG", () => {
  it("keeps non-model Butler work usable and fails only model resolution", async () => {
    const stub = env.BUTLER.get(env.BUTLER.idFromName("no-config-butler"));

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const instance = new ButlerDO(state, withoutConfig());
      return {
        schedules: await instance.listSchedules(),
        model: await captureError(() =>
          (instance as unknown as ButlerModelPath).ensureModel(),
        ),
      };
    });

    expect(result.schedules).toEqual([]);
    expect(result.model).toEqual({
      isRuntimeConfigError: true,
      code: "CONFIG_MISSING",
    });
  });

  it("keeps non-model Task work usable and fails start at model selection", async () => {
    const stub = env.TASK.get(env.TASK.idFromName("no-config-task"));

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const instance = new TaskDO(state, withoutConfig());
      return {
        status: await instance.status(),
        start: await captureError(() =>
          instance.start({
            taskId: "no-config",
            title: "No config",
            instructions: "do the thing",
          }),
        ),
      };
    });

    expect(result.status).toEqual({ state: "queued", title: "" });
    expect(result.start).toEqual({
      isRuntimeConfigError: true,
      code: "CONFIG_MISSING",
    });
  });

  it("logs and skips MCP tools without caching a rejected promise", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stub = env.TASK.get(env.TASK.idFromName("no-config-mcp"));

      const result = await runInDurableObject(stub, async (_instance, state) => {
        const instance = new TaskDO(state, withoutConfig());
        const ensure = () =>
          (instance as unknown as TaskMcpPath).ensureMcpTools();
        const outcome = async () =>
          ensure().then(
            () => "resolved",
            (failure: unknown) => `rejected:${String(failure)}`,
          );
        return { first: await outcome(), second: await outcome() };
      });

      expect(result).toEqual({ first: "resolved", second: "resolved" });
      expect(error.mock.calls.flat().join(" ")).toContain("CONFIG_MISSING");
    } finally {
      error.mockRestore();
    }
  });
});
