import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Bar, type ChartTone } from "@/components/charts";
import { useApp } from "@/components/app-context";
import { tryT, useT } from "@/i18n";
import { isCode } from "@/services/errors";
import { useLifeVitalsQuery } from "@/services/queries";
import type { LifeVitalsDTO } from "@/services/types";
import type { ReactNode } from "react";

export function formatUsd(n: number): string {
  return (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);
}

export function sourceLabel(source: string): string {
  if (source === "butler") return tryT("overview.sourceButler") ?? source;
  if (source.startsWith("task:")) return tryT("overview.sourceTask") ?? source;
  if (source.startsWith("bot:") || source.startsWith("bot-chat:")) {
    return tryT("overview.sourceBot") ?? source;
  }
  return source;
}

// The runway gauge reads against a month: longer than that fills the bar, which
// is the right story for "no hurry".
const RUNWAY_SCALE_DAYS = 30;

const TIER_TONE: Record<string, ChartTone> = {
  ample: "emerald",
  lean: "amber",
  critical: "red",
  dormant: "muted",
};

function NormalVitals({ vitals }: { vitals: LifeVitalsDTO }) {
  const t = useT();
  const runway = vitals.runwayDays;
  const maxSource = Math.max(...vitals.topSources.map((source) => source.usd), 0);
  return (
    <>
      <Badge data-testid="vitals-tier">
        {tryT(`overview.tier_${vitals.tier}`) ?? vitals.tier}
      </Badge>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{t("overview.balance")}</dt>
          <dd className="mt-1 text-2xl font-semibold" data-i18n-ignore>
            {formatUsd(vitals.balanceUsd)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("overview.dailySpend")}</dt>
          <dd className="mt-1 text-sm" data-i18n-ignore>
            {formatUsd(vitals.dailySpendUsd)}
          </dd>
        </div>
      </dl>
      {runway !== null && runway > 0 ? (
        <div className="mt-2 space-y-1.5" data-testid="vitals-runway">
          <p className="text-sm text-muted-foreground">
            {runway >= 1
              ? t("overview.runway", { days: Math.floor(runway) })
              : t("overview.runwayUnderDay")}
          </p>
          <Bar value={runway} max={RUNWAY_SCALE_DAYS} tone={TIER_TONE[vitals.tier] ?? "primary"} />
          <div className="flex justify-between text-[10px] text-muted-foreground/70">
            <span>0</span>
            <span>{t("overview.runwayScale")}</span>
          </div>
        </div>
      ) : null}
      {vitals.unpriced ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("overview.unpriced")}</p>
      ) : null}
      {vitals.topSources.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs text-muted-foreground">{t("overview.topSources")}</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {vitals.topSources.map((source, index) => (
              <li key={source.source} className="space-y-1">
                <div className="flex items-center justify-between gap-4">
                  <span>{sourceLabel(source.source)}</span>
                  <span data-i18n-ignore>{formatUsd(source.usd)}</span>
                </div>
                <Bar
                  value={source.usd}
                  max={maxSource}
                  tone={index === 0 ? "primary" : "primarySoft"}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function VitalsCard() {
  const t = useT();
  const { navigate } = useApp();
  const query = useLifeVitalsQuery();
  const vitals = query.data;

  let body: ReactNode;
  if (query.isLoading) {
    body = <p className="text-sm text-muted-foreground">{t("overview.vitalsLoading")}</p>;
  } else if (query.error) {
    body = isCode(query.error, "LIFE_VITALS_UNSUPPORTED") ? (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("overview.vitalsUnsupported")}</p>
        <Button type="button" size="sm" onClick={() => navigate("updates")}>
          {t("overview.goToGrowth")}
        </Button>
      </div>
    ) : (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("overview.vitalsFailed")}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  } else if (!vitals || !vitals.metabolismStarted) {
    body = <p className="text-sm text-muted-foreground">{t("overview.vitalsUnstarted")}</p>;
  } else {
    body = <NormalVitals vitals={vitals} />;
  }

  return (
    <Card className="mt-4" data-testid="vitals-card">
      <CardContent className="pt-4">
        <h2 className="text-sm font-semibold">{t("overview.vitals")}</h2>
        <div className="mt-3">{body}</div>
      </CardContent>
    </Card>
  );
}
