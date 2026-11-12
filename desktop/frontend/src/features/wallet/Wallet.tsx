import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDirty } from "@/components/use-dirty";
import { useT, type MessageKey } from "@/i18n";
import { useInvalidate } from "@/services/queries";
import type { WalletEditDTO, WalletStatusDTO } from "@/services/types";
import {
  walletDraftEmpty,
  walletProblems,
  type WalletDraft,
  type WalletProblem,
} from "./validate";

const EMPTY: WalletDraft = { privateKey: "", ownerAddress: "", rpcUrl: "" };

const PROBLEM_COPY: Record<WalletProblem, MessageKey> = {
  privateKey: "wallet.problemPrivateKey",
  ownerAddress: "wallet.problemOwnerAddress",
  rpcUrl: "wallet.problemRpcUrl",
};

export function Wallet() {
  const { client } = useApp();
  const t = useT();
  const invalidate = useInvalidate();
  const [draft, setDraft] = useState<WalletDraft>(EMPTY);
  const [status, setStatus] = useState<WalletStatusDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await client.walletStatus());
    } catch (cause) {
      setError(cause);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const problems = walletProblems(draft);
  const empty = walletDraftEmpty(draft);
  useDirty(!empty);

  const update = (field: keyof WalletDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setSuccess(false);
  };

  const save = async () => {
    if (saving || empty || problems.length > 0) return;
    const privateKey = draft.privateKey.trim();
    const ownerAddress = draft.ownerAddress.trim();
    const rpcUrl = draft.rpcUrl.trim();
    const input: WalletEditDTO = {
      ...(privateKey !== "" ? { privateKey } : {}),
      ...(ownerAddress !== "" ? { ownerAddress } : {}),
      ...(rpcUrl !== "" ? { rpcUrl } : {}),
    };
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await client.saveWallet(input);
      // A pasted key cannot be read back, so clear every draft field at once.
      setDraft(EMPTY);
      setSuccess(true);
      invalidate.config();
      await loadStatus();
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };

  const configured = status?.configured === true;

  return (
    <div>
      <PageHeader
        title={t("shell.pages.wallet")}
        description={t("wallet.intro")}
        actions={
          <Badge variant="outline">
            <ShieldCheck aria-hidden />
            {t("wallet.keysNeverEchoed")}
          </Badge>
        }
      />

      <ErrorAlert
        error={error}
        onReload={error && status === null ? () => void loadStatus() : undefined}
        reloadLabel={t("wallet.reload")}
      />
      {success ? (
        <Alert className="my-4" role="status">
          <AlertDescription>{t("wallet.saved")}</AlertDescription>
        </Alert>
      ) : null}

      <section className="rounded-md border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">{t("wallet.status")}</p>
          {loading && status === null ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                aria-hidden
              />
              {t("wallet.loading")}
            </span>
          ) : status ? (
            <Badge
              variant={configured ? "secondary" : "outline"}
              data-testid="wallet-status"
            >
              {configured ? t("wallet.configured") : t("wallet.notConfigured")}
            </Badge>
          ) : null}
        </div>

        {configured && status ? (
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("wallet.walletAddress")}
              </dt>
              <dd
                className="mt-1 break-all font-mono text-xs"
                data-testid="wallet-address"
              >
                {status.address ?? ""}
              </dd>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("wallet.walletAddressHint")}
              </p>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("wallet.value")}</dt>
              <dd className="mt-1 text-sm" data-testid="wallet-value">
                {status.valueUsd === undefined
                  ? t("wallet.valueUnavailable")
                  : `≈ $${status.valueUsd.toFixed(2)}`}
              </dd>
            </div>
          </dl>
        ) : null}
      </section>

      <div className="mt-4 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="wallet-private-key">{t("wallet.privateKey")}</Label>
          <Input
            id="wallet-private-key"
            type="password"
            value={draft.privateKey}
            onChange={(event) => update("privateKey", event.target.value)}
            placeholder={
              configured
                ? t("wallet.keyPlaceholderConfigured")
                : t("wallet.keyPlaceholderNew")
            }
            autoComplete="new-password"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{t("wallet.privateKeyHint")}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="wallet-owner-address">{t("wallet.ownerAddress")}</Label>
          <Input
            id="wallet-owner-address"
            value={draft.ownerAddress}
            onChange={(event) => update("ownerAddress", event.target.value)}
            placeholder={
              configured
                ? t("wallet.keyPlaceholderConfigured")
                : t("wallet.ownerAddressPlaceholder")
            }
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{t("wallet.ownerAddressHint")}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="wallet-rpc-url">{t("wallet.rpcUrl")}</Label>
          <Input
            id="wallet-rpc-url"
            value={draft.rpcUrl}
            onChange={(event) => update("rpcUrl", event.target.value)}
            placeholder={t("wallet.rpcUrlPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{t("wallet.rpcUrlHint")}</p>
        </div>

        {problems.map((problem) => (
          <p key={problem} className="text-xs text-destructive">
            {t(PROBLEM_COPY[problem])}
          </p>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t("wallet.unchangedKept")}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadStatus()}
            disabled={saving}
          >
            <RefreshCw aria-hidden />
            {t("wallet.reload")}
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={saving || empty || problems.length > 0}
          >
            {saving ? (
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <Save aria-hidden />
            )}
            {saving ? t("wallet.saving") : t("wallet.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
