import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentLine } from "../../src/channels/inbox";
import {
  QUOTA_EXHAUSTED_TEXT,
  WORKERS_AI_QUOTA_MARKER,
  lastModelError,
} from "../../src/llm/model-errors";
import {
  createModelsForEnv,
  modelReadiness,
  setModelOverride,
} from "../../src/llm/models";
import { toUserInput, turnBlocker, unansweredText } from "../../src/butler/model-gate";
import { errorNotice } from "../../src/butler/owner-copy";
import { scriptedModel } from "../helpers/scripted-model";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const ENV = env as unknown as Record<string, unknown>;
const savedEnv = new Map<string, unknown>();

/** Mutates the env seen by Durable Objects created after this call. */
function setEnv(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!savedEnv.has(key)) savedEnv.set(key, ENV[key]);
    ENV[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete ENV[key];
    else ENV[key] = value;
  }
  savedEnv.clear();
}

const TEXT_ONLY_MODEL = {
  schemaVersion: 1,
  owner: { telegramUserIds: [1] },
  models: {
    butler: { provider: "my-proxy", id: "gpt-5.6" },
    task: { provider: "my-proxy", id: "gpt-5.6" },
    customProviders: [
      {
        id: "my-proxy",
        api: "openai-completions",
        baseUrl: "https://proxy.example.com/v1",
        models: [{ id: "gpt-5.6" }],
      },
    ],
  },
  mcpServers: [],
};

afterEach(() => {
  setModelOverride(null);
  restoreEnv();
});

describe("turnBlocker", () => {
  it("lets an available model take a text-only turn", () => {
    setModelOverride(scriptedModel([]));

    expect(turnBlocker(env, false)).toBeUndefined();
  });

  it("lets an available model take a turn with images", () => {
    setModelOverride(scriptedModel([]));

    expect(turnBlocker(env, true)).toBeUndefined();
  });

  it("returns the readiness copy for an unavailable model", () => {
    setModelOverride(null);
    setEnv({
      DESKWAND_CONFIG: {
        schemaVersion: 1,
        owner: { telegramUserIds: [1] },
        models: {
          butler: { provider: "opencode-go", id: "does-not-exist" },
          task: { provider: "opencode-go", id: "deepseek-v4.1-flash" },
        },
        mcpServers: [],
      },
    });
    const ref = { provider: "opencode-go", id: "does-not-exist" };
    const readiness = modelReadiness(env, createModelsForEnv(env), ref);

    expect(readiness).toBeTruthy();
    expect(turnBlocker(env, false)).toBe(readiness);
  });

  it("returns the image copy when the model cannot see images", () => {
    setModelOverride(null);
    setEnv({ DESKWAND_CONFIG: TEXT_ONLY_MODEL, MODEL_KEY_MY_PROXY: "k" });

    expect(turnBlocker(env, false)).toBeUndefined();
    expect(turnBlocker(env, true)).toBe(
      "当前模型不支持图片，请在桌面端模型页换成支持视觉的模型",
    );
  });
});

describe("toUserInput", () => {
  it("passes plain text through", () => {
    expect(toUserInput("hi", [], [])).toBe("hi");
  });

  it("keeps an empty body empty", () => {
    expect(toUserInput(null, [], [])).toBe("");
  });

  it("puts text before the images", () => {
    const image = { mimeType: "image/png", data: "AAAA" };

    expect(toUserInput("hi", [image], [])).toEqual([
      { type: "text", text: "hi" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("sends images without a text part when there is no text", () => {
    const image = { mimeType: "image/png", data: "AAAA" };

    expect(toUserInput(null, [image], [])).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("appends the attachment lines to the text", () => {
    const file = {
      name: "report.pdf",
      key: "inbox/tg:1/report.pdf",
      mimeType: "application/pdf",
      size: 2048,
    };

    expect(toUserInput("hi", [], [file])).toBe(
      `hi\n${attachmentLine(file)}`,
    );
    expect(toUserInput(null, [], [file])).toBe(attachmentLine(file));
  });
});

describe("unansweredText", () => {
  const transcriptWith = (marker: string) =>
    [
      {
        model: [
          { role: "assistant", stopReason: "error", errorMessage: marker },
        ],
      },
    ] as unknown as Parameters<typeof lastModelError>[0];

  it("explains an exhausted Workers AI allowance", async () => {
    expect(
      await unansweredText(
        "model_error",
        async () => transcriptWith(WORKERS_AI_QUOTA_MARKER),
        "zh",
      ),
    ).toBe(QUOTA_EXHAUSTED_TEXT);
  });

  it("falls back to the generic error when the transcript cannot be read", async () => {
    expect(
      await unansweredText(
        "model_error",
        async () => {
          throw new Error("transcript unavailable");
        },
        "zh",
      ),
    ).toBe(errorNotice("zh"));
  });

  it("uses the generic error for other reasons", async () => {
    expect(
      await unansweredText(
        "aborted",
        async () => transcriptWith(WORKERS_AI_QUOTA_MARKER),
        "zh",
      ),
    ).toBe(errorNotice("zh"));
  });
});
