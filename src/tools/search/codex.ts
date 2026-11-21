import { codexAccessToken } from "../../llm/codex";
import type { ModelRef } from "../../llm/models";
import type { SearchResult } from "./types";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const MAX_SOURCES = 5;
const MAX_ERROR_DETAIL = 200;

/** The hosted tool writes the answer, so the prompt asks for prose and sources. */
const INSTRUCTIONS =
  "Search the web with the web_search tool and answer the question, citing the sources you used. Answer in the language of the question."; // i18n-ignore: model-facing

type Citation = { title: string; url: string };

/** One parsed `data:` frame of the Codex stream; only the fields we read. */
type StreamEvent = {
  type?: unknown;
  error?: { message?: unknown };
  response?: { error?: { message?: unknown } };
  item?: {
    type?: unknown;
    content?: Array<{
      type?: unknown;
      text?: unknown;
      annotations?: Array<{ type?: unknown; title?: unknown; url?: unknown }>;
    }>;
  };
};

function parseSse(body: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const frame of body.split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data === "") continue;
    try {
      events.push(JSON.parse(data) as StreamEvent);
    } catch {
      // Keep-alives and a truncated tail carry nothing we can use.
    }
  }
  return events;
}

function failureOf(event: StreamEvent): string | undefined {
  if (event.type !== "response.failed" && event.type !== "error") {
    return undefined;
  }
  const message = event.error?.message ?? event.response?.error?.message;
  return typeof message === "string" && message !== ""
    ? message
    : String(event.type);
}

function readAnswer(events: StreamEvent[]): {
  text: string;
  citations: Citation[];
} {
  const parts: string[] = [];
  const citations: Citation[] = [];
  for (const event of events) {
    if (event.type !== "response.output_item.done") continue;
    const item = event.item;
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type !== "output_text") continue;
      if (typeof part.text === "string") parts.push(part.text);
      for (const annotation of part.annotations ?? []) {
        if (annotation?.type !== "url_citation") continue;
        if (typeof annotation.url !== "string" || annotation.url === "") continue;
        citations.push({
          title: typeof annotation.title === "string" ? annotation.title : "",
          url: annotation.url,
        });
      }
    }
  }
  return { text: parts.join("\n\n").trim(), citations };
}

/**
 * The answer links its sources inline, but a page the model read without
 * linking it is still worth listing. Anything already in the text is dropped so
 * the output does not repeat itself.
 */
function withSources(answer: { text: string; citations: Citation[] }): string {
  const listed: string[] = [];
  const seen = new Set<string>();
  for (const citation of answer.citations) {
    if (seen.has(citation.url) || answer.text.includes(citation.url)) continue;
    seen.add(citation.url);
    listed.push(
      `- ${[citation.title, citation.url].filter((part) => part !== "").join(" ")}`,
    );
    if (listed.length === MAX_SOURCES) break;
  }
  return listed.length === 0
    ? answer.text
    : `${answer.text}\n\n来源：\n${listed.join("\n")}`; // i18n-ignore: model-facing
}

/** A Cloudflare block answers with a web page; echoing it buries the status. */
async function errorDetail(response: Response): Promise<string> {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/html")) return "";
  const text = (await response.text().catch(() => "")).trim();
  return text === "" ? "" : `：${text.slice(0, MAX_ERROR_DETAIL)}`; // i18n-ignore: model-facing
}

/**
 * One search through the subscription's hosted `web_search` tool: a plain
 * Responses call with the tool declared, read to completion. Every failure
 * throws so the caller can fall back to the configured provider.
 *
 * The result count is not a parameter: the hosted tool decides how many pages
 * to read, and the answer arrives as prose with citations, not a result list.
 */
export async function subscriptionSearch(
  env: Env,
  model: ModelRef,
  query: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResult[]> {
  const token = await codexAccessToken(env, signal, fetchImpl);
  if (token === undefined) throw new Error("没有可用的 Codex 授权"); // i18n-ignore: model-facing

  const response = await fetchImpl(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access}`,
      "chatgpt-account-id": token.accountId,
      // Codex rejects a request without it; it is not attribution.
      originator: "pi",
      "OpenAI-Beta": "responses=experimental",
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: model.id,
      store: false,
      stream: true,
      instructions: INSTRUCTIONS,
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Codex 搜索返回 HTTP ${response.status}${await errorDetail(response)}`, // i18n-ignore: model-facing
    );
  }

  const events = parseSse(await response.text());
  for (const event of events) {
    const failure = failureOf(event);
    if (failure !== undefined) {
      throw new Error(`Codex 搜索失败：${failure}`); // i18n-ignore: model-facing
    }
  }

  const answer = readAnswer(events);
  return answer.text === ""
    ? []
    : [{ title: "", url: "", snippet: withSources(answer) }];
}
