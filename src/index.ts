import { DurableObject } from "cloudflare:workers";

export { TestHarnessDO } from "./testing/test-harness-do";

// Placeholder control-plane object; the implementation lands in a later task.
export class ButlerDO extends DurableObject<Env> {}

// Placeholder execution-plane object; the implementation lands in a later task.
export class TaskDO extends DurableObject<Env> {}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
