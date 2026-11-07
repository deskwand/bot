import type { UserInput } from "@earendil-works/pi-durable";
import { attachmentLine } from "../channels/inbox";
import { ownerLocale, type Locale } from "../i18n";
import {
  lastModelError,
  userTextForModelError,
} from "../llm/model-errors";
import {
  createModelsForEnv,
  modelAcceptsImages,
  modelReadiness,
} from "../llm/models";
import type { InboundFile, InboundImage } from "../protocol";
import { readRuntimeConfig } from "../runtime-config";
import { errorNotice, imageModelNotice } from "./owner-copy";

/**
 * The copy to send instead of submitting a turn, or `undefined` when the model
 * can take it. Covers both a model that cannot run at all and a text-only
 * model asked to look at images.
 */
export function turnBlocker(env: Env, hasImages: boolean): string | undefined {
  const models = createModelsForEnv(env);
  const butlerModel = readRuntimeConfig(env).models.butler;

  const notReady = modelReadiness(env, models, butlerModel);
  if (notReady) return notReady;

  if (hasImages && !modelAcceptsImages(models, butlerModel)) {
    return imageModelNotice(ownerLocale(env));
  }

  return undefined;
}

/** Builds the harness input: text, then one attachment line per file, then images. */
export function toUserInput(
  text: string | null,
  images: InboundImage[],
  files: InboundFile[],
): UserInput {
  const attachmentText = files.map(attachmentLine).join("\n");
  const modelText = [text, attachmentText]
    .filter((part): part is string => part !== null && part !== "")
    .join("\n");

  return images.length === 0
    ? modelText
    : [
        ...(modelText === ""
          ? []
          : [{ type: "text" as const, text: modelText }]),
        ...images.map((image) => ({
          type: "image" as const,
          data: image.data,
          mimeType: image.mimeType,
        })),
      ];
}

/**
 * The copy for a turn the harness left unanswered. `readMessages` is only
 * called for a model error; a failure to read it falls back to the generic
 * notice instead of throwing out of the message handler.
 */
export async function unansweredText(
  reason: string | undefined,
  readMessages: () => Promise<Parameters<typeof lastModelError>[0]>,
  locale: Locale,
): Promise<string> {
  let modelError: string | undefined;
  if (reason === "model_error") {
    try {
      modelError = lastModelError(await readMessages());
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      console.warn(
        `butler: could not read the transcript after a model error: ${failure}`,
      );
    }
  }
  return userTextForModelError(modelError, locale) ?? errorNotice(locale);
}
