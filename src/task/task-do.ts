import { DurableObject } from "cloudflare:workers";
import type { ActionEvent } from "../protocol";

/**
 * Execution-plane object: one instance per task. The behaviour lands in a
 * later task; this shell keeps the Durable Object binding resolvable.
 */
export class TaskDO extends DurableObject<Env> {
  async handleAction(_evt: ActionEvent): Promise<string> {
    return "暂不支持";
  }
}
