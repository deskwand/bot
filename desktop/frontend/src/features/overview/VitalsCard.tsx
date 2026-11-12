import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

function NormalVitals({ vitals }: { vitals: LifeVitalsDTO }) {
  const t = useT();
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
      {vitals.runwayDays !== null && vitals.runwayDays >= 1 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("overview.runway", { days: Math.floor(vitals.runwayDays) })}
        </p>
      ) : vitals.runwayDays !== null &&
        vitals.runwayDays > 0 &&
        vitals.runwayDays < 1 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("overview.runwayUnderDay")}
        </p>
      ) : null}
      {vitals.unpriced ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("overview.unpriced")}</p>
      ) : null}
      {vitals.topSources.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs text-muted-foreground">{t("overview.topSources")}</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {vitals.topSources.map((source) => (
              <li key={source.source} className="flex items-center justify-between gap-4">
                <span>{sourceLabel(source.source)}</span>
                <span data-i18n-ignore>{formatUsd(source.usd)}</span>
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
