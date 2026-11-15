import type { EntryRecord } from "@earendil-works/pi-durable";
import type { TaskRow } from "./tasks-repo";
import type { LedgerRow } from "./ledger";
import type { ExperienceSource } from "./self-store";
export type SourceRequest = Pick<ExperienceSource, "kind" | "ref">;
export type SourceCandidate = {
  kind: Exclude<ExperienceSource["kind"], "reflection">;
  ref: string;
  excerpt: string;
};
export type SelfSourceReader = {
  listSources(): Promise<SourceCandidate[]>;
  resolveSource(source: SourceRequest): Promise<ExperienceSource | null>;
};
export type SelfSourceDeps = {
  messages(): Promise<readonly EntryRecord[]>;
  tasks(): readonly TaskRow[];
  botMessages(): readonly LedgerRow[];
};
/** Evidence is data, never an instruction or an authority grant. */
export function escapeSelfData(text: string): string {
  return text.replaceAll("<<<", "‹‹‹").replaceAll(">>>", "›››");
}
export function boundedSelfData(text: string, max: number): string {
  const points = [...escapeSelfData(text)];
  return points.length > max
    ? points.slice(0, max - 1).join("") + "…"
    : points.join("");
}
export function createSelfSourceReader(deps: SelfSourceDeps): SelfSourceReader {
  const entries = async (): Promise<SourceCandidate[]> => {
    const result: SourceCandidate[] = [];
    for (const entry of await deps.messages()) {
      for (const message of entry.model ?? []) {
        let kind: SourceCandidate["kind"];
        let content;
        if (entry.kind === "butler.owner_message" && message.role === "user") {
          const data = entry.data;
          // Legacy assembled prompts cannot prove which text the owner wrote.
          // Do not promote their host-generated prefixes into owner evidence.
          if (
            data === null ||
            typeof data !== "object" ||
            Array.isArray(data) ||
            typeof data.ownerText !== "string" ||
            data.ownerText === ""
          )
            continue;
          kind = "owner_message";
          content = data.ownerText;
        } else if (
          entry.kind === "pi.tool-result" &&
          message.role === "toolResult" &&
          message.toolName === "quick_lookup" &&
          !message.isError
        ) {
          kind = "observation";
          content = message.content;
        } else continue;
        const text =
          typeof content === "string"
            ? content
            : content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n");
        result.push({
          kind,
          ref: `entry:${entry.id}`,
          excerpt: boundedSelfData(text, 400),
        });
      }
    }
    return result;
  };
  const tasks = (): SourceCandidate[] =>
    deps
      .tasks()
      .filter(
        (r) =>
          ["completed", "failed", "cancelled"].includes(r.status) &&
          r.summary !== null &&
          r.summary !== "",
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r) => ({
        kind: "task",
        ref: r.id,
        excerpt: boundedSelfData(r.summary!, 400),
      }));
  const bots = (): SourceCandidate[] =>
    deps
      .botMessages()
      .filter((r) => r.kind === "bot.message")
      .sort((a, b) => b.at - a.at || b.id - a.id)
      .map((r) => ({
        kind: "bot",
        ref: `ledger:${r.id}`,
        excerpt: boundedSelfData(r.line, 400),
      }));
  return {
    async listSources() {
      const all = await entries();
      return [
        ...all
          .filter((r) => r.kind === "owner_message")
          .slice(-5)
          .reverse(),
        ...tasks().slice(0, 5),
        ...bots().slice(0, 5),
        ...all
          .filter((r) => r.kind === "observation")
          .slice(-5)
          .reverse(),
      ];
    },
    async resolveSource(source) {
      if (source.kind === "reflection")
        return source.ref === null ? { ...source, excerpt: "" } : null;
      const all =
        source.kind === "task"
          ? tasks()
          : source.kind === "bot"
            ? bots()
            : await entries();
      return (
        all.find((r) => r.kind === source.kind && r.ref === source.ref) ?? null
      );
    },
  };
}
