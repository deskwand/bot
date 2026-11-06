import { useState } from "react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/components/app-context";
import { useT } from "@/i18n";
import type { ConfigDTO } from "@/services/types";

/**
 * Global switch for the autonomous approval mode. It publishes a one-field
 * config patch, so every other setting keeps its current value.
 */
export function ApprovalModeSwitch({
  config,
  disabled = false,
  onPublished,
  onError,
}: {
  config: ConfigDTO;
  disabled?: boolean;
  /** Refetches the config (and anything derived from it) after a publish. */
  onPublished: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const { client } = useApp();
  const t = useT();
  // The value being published. It stays shown, and the switch stays locked,
  // until the refetched config arrives, so a second click never carries the
  // stale fingerprint.
  const [pending, setPending] = useState<boolean | null>(null);
  const autonomous = pending ?? config.approvalMode !== "reviewed";

  const choose = async (next: boolean) => {
    setPending(next);
    try {
      await client.publishConfig({
        baseFingerprint: config.fingerprint,
        approvalMode: next ? "autonomous" : "reviewed",
      });
      await onPublished();
    } catch (cause) {
      onError(cause);
    } finally {
      setPending(null);
    }
  };

  return (
    <Card className="mt-5" data-testid="approval-mode">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{t("mcp.approvalMode.label")}</CardTitle>
            <CardDescription>{t("mcp.approvalMode.description")}</CardDescription>
          </div>
          <Switch
            checked={autonomous}
            disabled={disabled || pending !== null}
            aria-label={t("mcp.approvalMode.label")}
            onCheckedChange={(next) => void choose(next)}
          />
        </div>
      </CardHeader>
    </Card>
  );
}
