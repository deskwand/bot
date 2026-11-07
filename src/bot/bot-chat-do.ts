import { Agent } from "agents";
import { PiHarness, type PiModel } from "agents/harness/pi";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { ownerLocale, t, type Locale } from "../i18n";
import { createModelsForEnv, resolveModel } from "../llm/models";
import { PI_PROGRESS } from "../llm/pi-settings";
import type { InboundImage } from "../protocol";
import { RuntimeConfigError, readRuntimeConfig } from "../runtime-config";
import {
  toUserInput,
  turnBlocker,
  unansweredText,
} from "../butler/model-gate";
import { createBotChatTools, type BotSelf } from "./bot-chat-tools";
import { botChatSystemPrompt } from "./instructions";

export type BotChatInput = {
  botId: string;
  /** The message text after the address was removed; may be empty. */
  text: string;
  images?: InboundImage[];
  /** Used as the harness operation id, so a redelivery is answered once. */
  eventId: string;
};

/** The Butler RPCs a bot chat depends on. Structural so tests can fake it. */
export type BotChatButler = {
  notifyFromBot(botId: string, text: string): Promise<boolean>;
  ownerProfile(): Promise<string>;
};

const BOT_ID_KEY = "botId";

let butlerOverride: BotChatButler | null = null;

let botOverride: ((id: string) => BotSelf) | null = null;

/**
 * Test-only override for the Butler and Bot the chat talks to, mirroring
 * `setBotButlerOverride`. Passing `null` (or omitting a key) restores the real
 * bindings.
 */
export function setBotChatOverrides(o: {
  butler?: BotChatButler | null;
  bot?: ((id: string) => BotSelf) | null;
}): void {
  if ("butler" in o) butlerOverride = o.butler ?? null;
  if ("bot" in o) botOverride = o.bot ?? null;
}

/**
 * One bot's direct conversation with the owner. Each bot gets its own object
 * (`env.BOT_CHAT.idFromName(botId)`); the transcript is pi's, so the Bot DO
 * never has to grow a chat mode.
 */
export class BotChatDO extends Agent<Env> {
  readonly registry = createRegistry();

  readonly harness: PiHarness;

  /** The model last applied to this chat's session (see `ensureModel`). */
  private appliedModel: PiModel | undefined;

  /** The system prompt built from the snapshot for the current turn. */
  private prompt = "";

  /** The rules text written during this turn, or `null` for none. */
  private rulesWritten: string | null = null;

  /** In-memory queue: concurrent chats of one bot run one after another. */
  private turn: Promise<void> = Promise.resolve();

  private botId: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Installed once, at construction: Pi may re-run the harness factory after
    // a storage error, so registry changes must not depend on it.
    this.registry.install({
      name: "bot-chat",
      tools: createBotChatTools(
        () => this.self(),
        (rules) => {
          this.rulesWritten = rules;
        },
      ),
      sections: [
        {
          key: "bot-chat",
          // A turn resumed in a fresh instance has no in-memory prompt, so
          // rebuild it from the bot snapshot. Such a turn's reply is not sent:
          // the Butler's original RPC already failed (accepted limit, see the
          // plan's "和 spec 不同的地方" item 1).
          render: async () => this.prompt || (await this.refreshPrompt()),
        },
      ],
    });

    const chat = this;
    const defaults = {
      get model(): PiModel | undefined {
        try {
          const model = resolveModel(
            readRuntimeConfig(chat.env).models.butler,
            chat.env,
          );
          chat.appliedModel = model;
          return model;
        } catch (error) {
          if (error instanceof RuntimeConfigError) return undefined;
          throw error;
        }
      },
    };

    this.harness = new PiHarness({
      harness: ({ storage, context, onWake }) =>
        Harness.open(
          storage,
          {
            models: createModelsForEnv(this.env),
            registry: this.registry,
            onWake,
            settings: { progress: PI_PROGRESS },
          },
          context,
        ),
      defaults,
    });

    // `Agent` already installed the lifecycle; adding to it is required.
    this.lifecycle.use(this.harness);
  }

  /**
   * Answers one owner message. Resolves after the turn's reply was sent, so a
   * failed send surfaces as a rejected RPC (the Butler then says the bot is
   * unavailable instead of retrying the message as its own instruction).
   */
  chat(input: BotChatInput): Promise<void> {
    const run = () => this.runTurn(input);
    this.turn = this.turn.then(run, run);
    return this.turn;
  }

  private async runTurn(input: BotChatInput): Promise<void> {
    this.botId = input.botId;
    // Kept in storage so tools still find their bot after an alarm resumes a
    // turn in a fresh instance.
    this.ctx.storage.kv.put(BOT_ID_KEY, input.botId);
    this.rulesWritten = null;

    const locale = ownerLocale(this.env);
    const prompt = await this.refreshPrompt();
    if (prompt === "") {
      await this.butler().notifyFromBot(
        input.botId,
        t(locale, "butler.botChat.deleted"),
      );
      return;
    }

    await this.ensureModel();

    const images = input.images ?? [];
    const blocked = turnBlocker(this.env, images.length > 0);
    if (blocked !== undefined) {
      await this.butler().notifyFromBot(input.botId, blocked);
      return;
    }

    const receipt = await this.harness.submit(
      toUserInput(input.text, images, []),
      { operationId: input.eventId },
    );
    // The same event was already accepted: never answer it twice.
    if (!receipt.accepted) return;

    const result = await this.harness.wait(input.eventId);
    const answer =
      result.status === "unanswered"
        ? await unansweredText(
            result.reason,
            () => this.harness.session().messages(),
            locale,
          )
        : (result.text ?? "");

    const text = this.withRulesConfirmation(answer, locale);
    if (text.length > 0) {
      await this.butler().notifyFromBot(input.botId, text);
    }
  }

  /**
   * Reads the bot snapshot and owner profile and stores the rendered system
   * prompt. Returns "" when the bot no longer exists.
   */
  private async refreshPrompt(): Promise<string> {
    const snapshot = await this.self().snapshot();
    if (snapshot === null) {
      this.prompt = "";
      return "";
    }
    const ownerProfile = await this.butler().ownerProfile();
    this.prompt = botChatSystemPrompt(snapshot, ownerProfile);
    return this.prompt;
  }

  /** Appends the code-generated confirmation after a rules write. */
  private withRulesConfirmation(answer: string, locale: Locale): string {
    if (this.rulesWritten === null) return answer;
    const confirmation =
      this.rulesWritten === ""
        ? t(locale, "butler.botChat.rulesDeleted")
        : t(locale, "butler.botChat.rulesUpdated", {
            rules: this.rulesWritten.slice(0, 200),
          });
    return answer.length > 0 ? `${answer}\n\n${confirmation}` : confirmation;
  }

  private async ensureModel(): Promise<void> {
    const model = resolveModel(
      readRuntimeConfig(this.env).models.butler,
      this.env,
    );
    if (
      this.appliedModel?.provider === model.provider &&
      this.appliedModel.id === model.id
    ) {
      return;
    }
    await this.harness.session().setModel(model);
    this.appliedModel = model;
  }

  private botIdNow(): string | undefined {
    return this.botId ?? this.ctx.storage.kv.get<string>(BOT_ID_KEY);
  }

  private self(): BotSelf {
    const id = this.botIdNow();
    if (id === undefined) throw new Error("bot chat has no bot id");
    if (botOverride !== null) return botOverride(id);
    return this.env.BOT.get(
      this.env.BOT.idFromName(id),
    ) as unknown as BotSelf;
  }

  private butler(): BotChatButler {
    if (butlerOverride !== null) return butlerOverride;
    return this.env.BUTLER.get(this.env.BUTLER.idFromName("owner"));
  }
}
