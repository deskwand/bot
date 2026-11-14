import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { pageSubtitle, useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { useT, type MessageKey } from "@/i18n";
import { toClientError } from "@/services/errors";
import { useBotsQuery, useBotQuery } from "@/services/queries";
import type { BotDTO, BotRunDTO } from "@/services/types";

/**
 * Local time in a fixed pattern. The page refreshes every 30 seconds, so a
 * relative phrasing would only add copy and test surface.
 */
function stamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "active") return "default";
  if (status === "paused") return "secondary";
  return "outline";
}

function statusLabel(t: (key: MessageKey) => string, status: string): string {
  switch (status) {
    case "active":
      return t("bots.status.active");
    case "paused":
      return t("bots.status.paused");
    case "finished":
      return t("bots.status.finished");
    default:
      // A status this client does not know is shown as the Worker named it.
      return status;
  }
}

function outcomeLabel(t: (key: MessageKey) => string, outcome: string): string {
  switch (outcome) {
    case "completed":
      return t("bots.outcome.completed");
    case "failed":
      return t("bots.outcome.failed");
    case "cancelled":
      return t("bots.outcome.cancelled");
    default:
      return outcome;
  }
}

export function Bots() {
  const t = useT();
  const { targetKind } = useApp();
  const query = useBotsQuery();
  const [openId, setOpenId] = useState<string | null>(null);

  const unsupported =
    query.error !== null && toClientError(query.error).code === "BOTS_UNSUPPORTED";

  return (
    <div data-testid="bots-page">
      <PageHeader title={t("shell.pages.bots")} subtitle={pageSubtitle("bots")} />
      {unsupported ? (
        <p data-testid="bots-unsupported" className="text-sm text-muted-foreground">
          {targetKind === "container"
            ? t("bots.unsupported.container")
            : t("bots.unsupported.cloudflare")}
        </p>
      ) : null}
      {query.error && !unsupported ? (
        <ErrorAlert error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      {query.data && query.data.bots.length === 0 ? (
        <p data-testid="bots-empty" className="text-sm text-muted-foreground">
          {t("bots.empty")}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {(query.data?.bots ?? []).map((bot) => (
          <BotRow
            key={bot.id}
            bot={bot}
            open={openId === bot.id}
            onToggle={() =>
              setOpenId((current) => (current === bot.id ? null : bot.id))
            }
          />
        ))}
      </ul>
    </div>
  );
}

function BotRow({
  bot,
  open,
  onToggle,
}: {
  bot: BotDTO;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const meta = bot.meta;
  return (
    <li
      data-testid={`bot-row-${bot.id}`}
      className="rounded-lg border border-border bg-card p-4"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-3 text-left"
      >
        <ChevronDown
          aria-hidden
          className={
            open
              ? "size-4 rotate-180 transition-transform"
              : "size-4 transition-transform"
          }
        />
        <span className="font-medium">{bot.name}</span>
        <span className="text-xs text-muted-foreground">{bot.id}</span>
        {meta ? (
          <Badge
            variant={statusVariant(meta.status)}
            data-testid={`bot-status-${bot.id}`}
          >
            {statusLabel(t, meta.status)}
          </Badge>
        ) : (
          <Badge variant="outline" data-testid={`bot-status-${bot.id}`}>
            {bot.unavailable ? t("bots.unavailable") : t("bots.noRecord")}
          </Badge>
        )}
        {meta?.earner ? <Badge variant="secondary">{t("bots.earner")}</Badge> : null}
        {meta && meta.consecutiveFailures > 0 ? (
          <span
            data-testid={`bot-failures-${bot.id}`}
            className="text-xs text-destructive"
          >
            {t("bots.failures")} {meta.consecutiveFailures}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {t("bots.currentTask")}
          {t("bots.sep")}
          {meta?.currentTaskId ?? t("bots.idle")}
        </span>
      </button>
      {meta ? (
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span>
            {t("bots.nextWake")}
            {t("bots.sep")}
            {meta.nextWakeAt === null
              ? t("bots.nextWakeNever")
              : stamp(meta.nextWakeAt)}
          </span>
          <span>
            {t("bots.interval")}
            {t("bots.sep")}
            {t("bots.minutes", {
              value: Math.round(meta.defaultIntervalMs / 60_000),
            })}
          </span>
          <span>{meta.mission}</span>
        </div>
      ) : null}
      {open ? <BotDetail id={bot.id} /> : null}
    </li>
  );
}

function BotDetail({ id }: { id: string }) {
  const t = useT();
  const query = useBotQuery(id);
  if (query.error) {
    return (
      <div className="mt-3">
        <ErrorAlert error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  if (!query.data) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        {t("shell.pageLoading")}
      </p>
    );
  }
  const { meta, docs, runs } = query.data;
  return (
    <div data-testid={`bot-detail-${id}`} className="mt-3 flex flex-col gap-3 text-sm">
      {meta ? (
        <div className="flex flex-col gap-1">
          <h3 className="font-medium">{t("bots.mission")}</h3>
          <p className="whitespace-pre-wrap text-muted-foreground">{meta.mission}</p>
          {meta.finishReason ? (
            <p className="text-muted-foreground">
              {t("bots.finishReason")}
              {t("bots.sep")}
              {meta.finishReason}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">{t("bots.docs")}</h3>
        {docs.length === 0 ? (
          <p className="text-muted-foreground">—</p>
        ) : (
          docs.map((doc) => (
            <div key={doc.name}>
              <p className="text-xs text-muted-foreground">{doc.name}</p>
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
                {doc.content}
              </pre>
            </div>
          ))
        )}
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">{t("bots.runs")}</h3>
        {runs.length === 0 ? (
          <p className="text-muted-foreground">{t("bots.noRuns")}</p>
        ) : (
          runs.map((run) => <RunLine key={run.taskId} run={run} />)
        )}
      </div>
    </div>
  );
}

function RunLine({ run }: { run: BotRunDTO }) {
  const t = useT();
  return (
    <p className="text-xs text-muted-foreground">
      {stamp(run.startedAt)} · {run.outcome ? outcomeLabel(t, run.outcome) : "—"} ·{" "}
      {(run.summary ?? "").slice(0, 120)}
    </p>
  );
}
