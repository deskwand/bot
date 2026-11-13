import { PiHarness } from "agents/harness/pi";
import type { ConversationId, Report, TaskId } from "@earendil-works/pi-durable";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";

type TaskStub = ReturnType<typeof env.TASK.get>;

/** Map only a genuinely settled old operation; retry admissions and results stay real. */
export function mapSettledFailureToRestartLimit(operationId: string) {
  const original = PiHarness.prototype.wait;
  return vi.spyOn(PiHarness.prototype, "wait").mockImplementation(
    async function (this: PiHarness, id, options) {
      const result = await original.call(this, id, options);
      if (id !== operationId) return result;
      expect(result.status).toBe("unanswered");
      return { ...result, reason: "restart_limit" };
    },
  );
}

/** A report alone says nothing about whether the surrounding run ended. */
export async function reportInterruption(stub: TaskStub, kind = "pi.generation") {
  await runInDurableObject(stub, (instance) => {
    const report = {
      kind: "task_interrupted",
      reason: "restart_limit",
      restarts: 3,
      task: { id: 1 as TaskId, kind, conversationId: 1 as ConversationId },
      error: new Error("synthetic restart limit"),
    } satisfies Report;
    (instance as unknown as { handleReport(report: Report): void }).handleReport(report);
  });
}

export async function operationIdOf(stub: TaskStub) {
  return runInDurableObject(stub, (instance) =>
    (instance as unknown as { readMeta(key: string): string | undefined }).readMeta("operation_id"),
  );
}
