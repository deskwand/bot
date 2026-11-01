import { DurableObject } from "cloudflare:workers";
import { Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  PiHarness,
  type PiOperationResult,
  type PiReceipt,
} from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createModelsForEnv, resolveModel } from "../llm/models";

/**
 * Test-only Durable Object that hosts a real `PiHarness`. It exists so the
 * spike test can drive Pi through a tool call without production DOs having to
 * expose test seams.
 */
export class TestHarnessDO extends DurableObject<Env> {
  readonly registry = createRegistry();

  readonly harness: PiHarness;

  readonly lifecycle: Lifecycle<Env>;

  private echoCalls = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const Echo = Type.Object({ text: Type.String() });
    const echo: ToolRegistration<typeof Echo> = {
      name: "echo",
      description: "Echo the given text back.",
      parameters: Echo,
      replay: "safe",
      execute: async ({ text }) => {
        this.echoCalls += 1;
        return { output: [{ type: "text", text }] };
      },
    };
    this.registry.install({ name: "test-harness", tools: [echo] });

    this.harness = new PiHarness({
      harness: ({ storage, context, onWake }) =>
        Harness.open(
          storage,
          {
            models: createModelsForEnv(this.env),
            registry: this.registry,
            onWake,
          },
          context,
        ),
      defaults: {
        model: resolveModel(
          { provider: "anthropic", id: "claude-sonnet-5-5" },
          this.env,
        ),
      },
    });

    this.lifecycle = Lifecycle.install(this).use(this.harness);
  }

  async ask(text: string): Promise<string> {
    const { text: answer } = await this.harness.prompt(text);
    return answer ?? "";
  }

  async submitPrompt(text: string, operationId: string): Promise<PiReceipt> {
    return this.harness.submit(text, { operationId });
  }

  async waitFor(operationId: string): Promise<PiOperationResult> {
    return this.harness.wait(operationId);
  }

  echoes(): number {
    return this.echoCalls;
  }
}
