import { Agent } from "agents";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PiHarness, type PiModel } from "agents/harness/pi";
import { assertModelWindowSwitch, ModelSwitchError } from "../llm/model-switch";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { ownerLocale, t, type Locale } from "../i18n";
import {
  createModelsForEnv,
  defaultThinkingLevel,
  resolveModel,
} from "../llm/models";
import { PI_PROGRESS } from "../llm/pi-settings";
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
 * One bot's direct conversation with the owner. Each bot generation gets its
 * own object (`env.BOT_CHAT.idFromName("<id>@<createdAt>")`, so a reused id
 * never inherits an older bot's transcript); the transcript is pi's, so the
 * Bot DO never has to grow a chat mode.
 */
export class BotChatDO extends Agent<Env> {
  readonly registry = createRegistry();

  readonly harness: PiHarness;

  /** The system prompt built from the snapshot for the current turn. */
  private prompt = "";

  /** The rules text written during this turn, or `null` for none. */
  private rulesWritten: string | null = null;

  /** In-memory queue: concurrent chats of one bot run one after another. */
  private turn: Promise<void> = Promise.resolve();

  /** True while `runTurn` runs; false when an alarm resumes a turn. */
  private activeTurn = false;

  private botId: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Installed once, at construction: Pi may re-run the harness factory after
    // a storage error, so registry changes must not depend on it.
    // Accepted risk: unlike the Butler's inbound path, chat tools do not check
    // the maintenance lease (they match the Butler's own tools).
    this.registry.install({
      name: "bot-chat",
      tools: createBotChatTools(
        () => this.self(),
        (rules) => {
          this.rulesWritten = rules;
          // A turn resumed from an alarm runs tools outside `runTurn`, so no
          // reply is left to carry the confirmation. Send it right away.
          if (!this.activeTurn) this.notifyRulesOutsideTurn(rules);
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
   * Answers one question from the Butler. Resolves with the reply text; it
   * never sends to the channel itself, so the Butler decides what the owner
   * hears.
   */
  ask(input: BotChatInput): Promise<string> {
    const result = this.turn.then(
      () => this.runTurn(input),
      () => this.runTurn(input),
    );
    this.turn = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runTurn(input: BotChatInput): Promise<string> {
    this.activeTurn = true;
    try {
      this.botId = input.botId;
      // Kept in storage so tools still find their bot after an alarm resumes a
      // turn in a fresh instance.
      this.ctx.storage.kv.put(BOT_ID_KEY, input.botId);
      this.rulesWritten = null;

      const locale = ownerLocale(this.env);
      const prompt = await this.refreshPrompt();
      if (prompt === "") {
        throw new Error(t(locale, "butler.botChat.deleted"));
      }

      try {
        await this.ensureAgent();
      } catch (error) {
        if (!(error instanceof ModelSwitchError)) throw error;
        throw new Error(error.message);
      }

      const blocked = turnBlocker(this.env, false);
      if (blocked !== undefined) throw new Error(blocked);

      const receipt = await this.harness.submit(toUserInput(input.text, [], []), {
        operationId: input.eventId,
      });
      // The same event was already accepted: never answer it twice.
      if (!receipt.accepted) return "";

      const result = await this.harness.wait(input.eventId);
      const answer =
        result.status === "unanswered"
          ? await unansweredText(
              result.reason,
              () => this.harness.session().messages(),
              locale,
            )
          : (result.text ?? "");

      // A rules confirmation is code-generated, so it rides along with the
      // reply instead of being rewritten by the speaker.
      const rules = this.rulesWritten;
      if (rules === null) return answer;
      const confirmation = this.confirmationFor(rules, locale);
      return answer.length > 0 ? `${answer}\n${confirmation}` : confirmation;
    } finally {
      this.activeTurn = false;
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
    this.prompt = botChatSystemPrompt(
      snapshot,
      ownerProfile,
      ownerLocale(this.env),
    );
    return this.prompt;
  }

  /** The code-generated confirmation for a rules write or deletion. */
  private confirmationFor(rules: string, locale: Locale): string {
    if (rules === "") return t(locale, "butler.botChat.rulesDeleted");
    const shown =
      rules.length > 200
        ? rules.slice(0, 200) +
          t(locale, "butler.botChat.rulesTruncated", { count: rules.length })
        : rules;
    return t(locale, "butler.botChat.rulesUpdated", { rules: shown });
  }

  /**
   * Sends a rules confirmation when no `runTurn` is around to do it, as when
   * an alarm resumes a turn. Best effort: the owner still sees the rules when
   * they next talk to the bot.
   */
  private notifyRulesOutsideTurn(rules: string): void {
    const botId = this.botIdNow();
    if (botId === undefined) return;
    const confirmation = this.confirmationFor(rules, ownerLocale(this.env));
    void this.butler()
      .notifyFromBot(botId, confirmation)
      .then((sent) => {
        if (!sent) console.warn(`bot chat ${botId}: rules notice not sent`);
      })
      .catch((error) => {
        console.error(`bot chat ${botId} rules notice failed:`, error);
      });
  }

  private async ensureAgent(): Promise<void> {
    const ref = readRuntimeConfig(this.env).models.butler;
    const model = resolveModel(ref, this.env);
    const models = createModelsForEnv(this.env);
    // Same guard as the Butler: read the persisted model and refuse a switch
    // that shrinks the context window too far.
    const conversation = await (await this.harness.pi()).root(
      BACKGROUND_CONTEXT,
    );
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    const active = agent.model;
    if (active?.provider !== model.provider || active.modelId !== model.id) {
      assertModelWindowSwitch(
        models,
        active ? { provider: active.provider, id: active.modelId } : undefined,
        model,
        ownerLocale(this.env),
      );
      await this.harness.session().setModel(model);
    }
    // Defaults only reach a new root; a level published later lands here, and
    // an unconfigured role falls back to the middle of what the model offers.
    const level =
      ref.thinkingLevel ??
      defaultThinkingLevel(models.getModel(ref.provider, ref.id));
    if (level !== undefined && level !== agent.thinkingLevel) {
      await conversation.configure({ thinkingLevel: level }, BACKGROUND_CONTEXT);
    }
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
