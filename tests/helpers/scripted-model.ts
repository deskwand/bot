import type { ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { PiModel } from "agents/harness/pi";
import { registerTestProvider } from "../../src/llm/models";

export type ScriptedTurn = {
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
  /** Ends the turn with a model error carrying this message. */
  error?: string;
  /** Called with the request context when the model is asked for this turn. */
  observe?: (context: TranscriptContext) => void;
};

let nextModel = 0;

/**
 * A `PiModel` backed by pi-ai's faux provider: each model request returns the
 * next scripted turn. Once the script is exhausted every request answers
 * `{ text: "done" }`.
 */
export function scriptedModel(
  turns: ScriptedTurn[],
  options: { contextWindow?: number } = {},
): PiModel {
  nextModel += 1;
  const id = `scripted-${nextModel}`;

  const faux = fauxProvider({ provider: id, api: id, models: [{ id, ...options }] });
  const steps: FauxResponseStep[] = turns.map((turn) => {
    const content = [
      ...(turn.text === undefined ? [] : [fauxText(turn.text)]),
      ...(turn.toolCalls ?? []).map((call) =>
        fauxToolCall(call.name, call.args as ToolCall["arguments"]),
      ),
    ];
    const stopReason =
      turn.error !== undefined
        ? "error"
        : turn.toolCalls?.length
          ? "toolUse"
          : "stop";
    const message = fauxAssistantMessage(content, {
      stopReason,
      ...(turn.error === undefined ? {} : { errorMessage: turn.error }),
    });
    return turn.observe
      ? (context: TranscriptContext) => {
          turn.observe!(context);
          return message;
        }
      : message;
  });
  faux.setResponses(steps);

  // The faux provider errors when its queue is empty. Top it up with the
  // documented fallback answer before every request instead.
  const provider: Provider = {
    ...faux.provider,
    stream: (model, context, options) => {
      refill(faux);
      return faux.provider.stream(model, context, options);
    },
    streamSimple: (model, context, options) => {
      refill(faux);
      return faux.provider.streamSimple(model, context, options);
    },
  };

  registerTestProvider(provider);
  return { provider: id, id };
}

function refill(faux: FauxProviderHandle): void {
  if (faux.getPendingResponseCount() === 0) {
    faux.appendResponses([fauxAssistantMessage("done")]);
  }
}
