import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useApp } from "@/components/app-context";
import { useT } from "@/i18n";
import { queryKeys } from "@/services/queries";
import { formatUsd } from "./VitalsCard";

export function WalletCard() {
  const { client, navigate } = useApp();
  const t = useT();
  const query = useQuery({
    queryKey: queryKeys.walletStatus,
    queryFn: () => client.walletStatus(),
    retry: false,
  });
  const wallet = query.data;
  if (query.error || !wallet?.configured || !wallet.address) return null;

  return (
    <button
      type="button"
      data-testid="wallet-card"
      onClick={() => navigate("agent")}
      className="mt-4 flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:bg-muted/50"
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold">{t("overview.walletTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground" data-i18n-ignore>
          {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
        </p>
        {wallet.valueUsd === undefined ? null : (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("overview.walletValue", { value: formatUsd(wallet.valueUsd) })}
          </p>
        )}
      </div>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}
