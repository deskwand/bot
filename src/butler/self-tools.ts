import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { t, type Locale } from "../i18n";
import type { SelfStore, Experience } from "./self-store";
import type { SelfSourceReader } from "./self-sources";
export type SelfToolDeps = SelfSourceReader & {
  store: SelfStore;
  locale: Locale;
  now(): number;
};
const object = { additionalProperties: false } as const;
const DocKind = Type.Union([
  Type.Literal("identity"),
  Type.Literal("situation"),
]);
const Source = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("owner_message"),
      Type.Literal("task"),
      Type.Literal("bot"),
      Type.Literal("observation"),
      Type.Literal("reflection"),
    ]),
    ref: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  },
  object,
);
const Query = Type.Union([
  Type.Object({ kind: Type.Literal("sources") }, object),
  Type.Object(
    {
      kind: Type.Union([DocKind, Type.Literal("experience")]),
      id: Type.Optional(Type.String()),
      keyword: Type.Optional(Type.String()),
      before: Type.Optional(Type.Integer({ minimum: 0 })),
      history: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    },
    object,
  ),
]);
export const selfOutput = (value: unknown, isError = false) => ({
  isError,
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
});
export function createSelfTools(deps: SelfToolDeps): ToolRegistration[] {
  const error = (reason = "invalid") =>
    selfOutput(
      { ok: false, reason, message: t(deps.locale, "butler.self.error") },
      true,
    );
  const read: ToolRegistration<typeof Query> = {
    name: "read_self",
    description: t(deps.locale, "butler.self.read"),
    parameters: Query,
    replay: "safe",
    async execute(query) {
      try {
        return selfOutput(
          query.kind === "sources"
            ? { sources: await deps.listSources() }
            : deps.store.read(query),
        );
      } catch {
        return error();
      }
    },
  };
  const Write = Type.Object(
    {
      kind: DocKind,
      content: Type.String(),
      expectedVersion: Type.Integer({ minimum: 0 }),
    },
    object,
  );
  const write: ToolRegistration<typeof Write> = {
    name: "write_self",
    description: t(deps.locale, "butler.self.write"),
    parameters: Write,
    async execute({ kind, content, expectedVersion }) {
      try {
        const result = deps.store.writeDoc(
          kind,
          content,
          expectedVersion,
          deps.now(),
        );
        return selfOutput(result, !result.ok);
      } catch {
        return error("write_failed");
      }
    },
  };
  const Record = Type.Object(
    {
      id: Type.Optional(Type.String()),
      expectedVersion: Type.Integer({ minimum: 0 }),
      facts: Type.String(),
      interpretation: Type.String(),
      source: Source,
      occurredAt: Type.Integer({ minimum: 0 }),
    },
    object,
  );
  const record: ToolRegistration<typeof Record> = {
    name: "record_experience",
    description: t(deps.locale, "butler.self.record"),
    parameters: Record,
    async execute(args) {
      try {
        const now = deps.now();
        if (
          args.occurredAt > now ||
          !Number.isSafeInteger(args.occurredAt) ||
          (!args.id && args.expectedVersion !== 0)
        )
          return error();
        const previous = args.id
          ? (deps.store.read({ kind: "experience", id: args.id }).records[0] as
              | Experience
              | undefined)
          : undefined;
        // Supplied ids identify revisions only; new ids are generated below.
        if (args.id && previous === undefined) return error();
        if (previous && previous.version !== args.expectedVersion)
          return selfOutput(
            { ok: false, reason: "conflict", current: previous ?? null },
            true,
          );
        const same =
          previous?.source.kind === args.source.kind &&
          previous.source.ref === args.source.ref;
        const source = same
          ? previous!.source
          : await deps.resolveSource(args.source);
        if (!source) return error("source_unavailable");
        const result = deps.store.recordExperience(
          { ...args, id: args.id ?? `e${crypto.randomUUID()}`, source },
          args.expectedVersion,
          now,
        );
        return selfOutput(result, !result.ok);
      } catch {
        return error("write_failed");
      }
    },
  };
  return [read, write, record];
}

export function createSelfWakeTools(deps: {
  locale: Locale;
  now(): number;
  setWake(at: number | null): Promise<import("./self-wake").SelfWakeState>;
  notify(text: string): Promise<boolean>;
}): ToolRegistration[] {
  const SetWake = Type.Object(
    { at: Type.Union([Type.String(), Type.Null()]) },
    object,
  );
  const Notify = Type.Object(
    { text: Type.String({ minLength: 1, maxLength: 4096 }) },
    object,
  );
  const fail = () =>
    selfOutput(
      {
        ok: false,
        reason: "invalid",
        message: t(deps.locale, "butler.self.error"),
      },
      true,
    );
  const set: ToolRegistration<typeof SetWake> = {
    name: "set_self_wake",
    description: t(deps.locale, "butler.self.setWake"),
    parameters: SetWake,
    async execute({ at }) {
      try {
        let time: number | null = null;
        if (at !== null) {
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at))
            return fail();
          time = Date.parse(at);
          const canonical = at.includes(".") ? at : at.replace("Z", ".000Z");
          if (
            !Number.isFinite(time) ||
            new Date(time).toISOString() !== canonical ||
            time < deps.now() + 300000 ||
            time > deps.now() + 30 * 86400000
          )
            return fail();
        }
        return selfOutput({ ok: true, value: await deps.setWake(time) });
      } catch {
        return fail();
      }
    },
  };
  const notify: ToolRegistration<typeof Notify> = {
    name: "notify_owner",
    description: t(deps.locale, "butler.self.notify"),
    parameters: Notify,
    async execute({ text }) {
      try {
        const ok = await deps.notify(text);
        return selfOutput({ ok }, !ok);
      } catch {
        return fail();
      }
    },
  };
  return [set, notify];
}
