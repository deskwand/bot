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
import { useInvalidate } from "@/services/queries";
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
  onPublished: () => void;
  onError: (error: unknown) => void;
}) {
  const { client } = useApp();
  const t = useT();
  const invalidate = useInvalidate();
  const [publishing, setPublishing] = useState(false);
  const autonomous = config.approvalMode !== "reviewed";

  const choose = async (next: boolean) => {
    setPublishing(true);
    try {
      await client.publishConfig({
        baseFingerprint: config.fingerprint,
        approvalMode: next ? "autonomous" : "reviewed",
      });
      invalidate.config();
      onPublished();
    } catch (cause) {
      onError(cause);
    } finally {
      setPublishing(false);
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
            disabled={disabled || publishing}
            aria-label={t("mcp.approvalMode.label")}
            onCheckedChange={(next) => void choose(next)}
          />
        </div>
      </CardHeader>
    </Card>
  );
}
