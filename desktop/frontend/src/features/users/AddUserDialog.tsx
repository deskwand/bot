import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useApp } from "@/components/app-context";
import { tryT, useT } from "@/i18n";
import { toClientError } from "@/services/errors";
import type { ChannelBindingDTO } from "@/services/types";

const TERMINAL = new Set(["confirmed", "cancelled", "expired", "failed", "denied"]);

function minutesLeft(deadline: number | null | undefined, now: number): number {
  if (deadline == null) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 60_000));
}

/**
 * The three-step add-user wizard. The invite itself lives on the server; this
 * dialog only renders the stage it is told and never holds the bearer token.
 */
export function AddUserDialog({
  onClose,
  resumeInviteId,
}: {
  onClose: () => void;
  resumeInviteId?: string;
}) {
  const t = useT();
  const { client } = useApp();
  const [label, setLabel] = useState("");
  const [inviteId, setInviteId] = useState<string | null>(resumeInviteId ?? null);
  const [pin, setPin] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => client.createChannel(label.trim()),
    onSuccess: (invite) => setInviteId(invite.inviteId),
    onError: (error: unknown) => {
      const failure = toClientError(error);
      setFailure(
        failure.code === "MEMBERS_WRONG_STAGE"
          ? t("users.wizard.wrongStage")
          : failure.code === "MEMBERS_PIN_EXHAUSTED"
            ? t("users.wizard.pinExhausted")
            : failure.message,
      );
      if (failure.code === "MEMBERS_WRONG_STAGE") void state.refetch();
    },
  });

  const state = useQuery({
    queryKey: ["member-invite", inviteId],
    queryFn: () => client.channelBindingState(inviteId as string),
    enabled: inviteId !== null,
    refetchInterval: (query) => {
      const stage = (query.state.data as ChannelBindingDTO | undefined)?.stage;
      return stage !== undefined && TERMINAL.has(stage) ? false : 2_000;
    },
  });

  const submitPin = useMutation({
    mutationFn: () => client.submitChannelPin(inviteId as string, pin),
    onSuccess: () => {
      setPin("");
      void state.refetch();
    },
    onError: (error: unknown) => setFailure(toClientError(error).message),
  });

  const cancel = useMutation({
    mutationFn: () => client.cancelChannelBinding(inviteId as string),
    onSuccess: () => onClose(),
    onError: (error: unknown) => setFailure(toClientError(error).message),
  });

  const current: ChannelBindingDTO | undefined = state.data;
  const stage = current?.stage ?? (inviteId === null ? "label" : "starting");
  const code = current?.failure ?? "unknown";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog">
      <div className="w-[24rem] rounded-lg bg-background p-5 shadow-xl">
        <h2 className="mb-4 text-base font-medium">{t("users.wizard.title")}</h2>
        {failure === null ? null : (
          <p data-testid="wizard-error" className="mb-3 text-sm text-destructive">
            {failure}
          </p>
        )}

        {stage === "label" ? (
          <div className="flex flex-col gap-3">
            <input
              data-testid="label-input"
              className="rounded border px-2 py-1.5 text-sm"
              placeholder={t("users.wizard.label")}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <button
              type="button"
              data-testid="create-invite"
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
              disabled={label.trim() === "" || create.isPending}
              onClick={() => {
                setFailure(null);
                create.mutate();
              }}
            >
              {t("users.wizard.create")}
            </button>
          </div>
        ) : null}

        {stage === "starting" ? (
          <p className="text-sm text-muted-foreground">{t("shell.readingStatus")}</p>
        ) : null}

        {stage === "realname" ? (
          <div className="flex flex-col items-center gap-3">
            {current?.realnameUrl ? (
              <div data-testid="qr-realname" className="bg-white p-3">
                <QRCodeSVG value={current.realnameUrl} size={188} marginSize={4} />
              </div>
            ) : null}
            <p className="text-sm">{t("users.wizard.realname")}</p>
            {current?.realnameDeadline ? (
              <p data-testid="realname-countdown" className="text-xs text-muted-foreground">
                {t("users.wizard.realnameCountdown", {
                  minutes: String(minutesLeft(current.realnameDeadline, Date.now())),
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        {stage === "scan" ? (
          <div className="flex flex-col items-center gap-3">
            {current?.qrContent ? (
              <div data-testid="qr-bind" className="bg-white p-3">
                <QRCodeSVG value={current.qrContent} size={188} marginSize={4} />
              </div>
            ) : null}
            <p className="text-sm">{t("users.wizard.scan")}</p>
          </div>
        ) : null}

        {stage === "pin" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">{t("users.wizard.pin")}</p>
            <input
              data-testid="pin-input"
              className="rounded border px-2 py-1.5 text-center text-sm tracking-[0.3em]"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
            />
            <button
              type="button"
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
              disabled={!/^\d{6}$/.test(pin) || submitPin.isPending}
              onClick={() => {
                setFailure(null);
                submitPin.mutate();
              }}
            >
              {t("users.wizard.submit")}
            </button>
          </div>
        ) : null}

        {stage === "saving" ? (
          <p className="text-sm text-muted-foreground">{t("users.wizard.saving")}</p>
        ) : null}

        {stage === "confirmed" ? (
          <p data-testid="wizard-done" className="text-sm">
            {t("users.wizard.done")}
          </p>
        ) : null}

        {TERMINAL.has(stage) && stage !== "confirmed" ? (
          <div className="flex flex-col gap-3">
            <p data-testid="wizard-dead" className="text-sm text-muted-foreground">
              {stage === "expired"
                ? t("users.wizard.expired")
                : stage === "cancelled"
                  ? t("users.wizard.cancelled")
                  : tryT(`users.wizard.failures.${code}`) ??
                    t("users.wizard.failed", { code })}
            </p>
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm"
              onClick={() => {
                const staleId = inviteId;
                setInviteId(null);
                setFailure(null);
                setLabel("");
                // An expired invite cannot be cancelled (the server answers
                // INVITE_CLOSED); dropping it locally is enough to start over.
                if (staleId !== null) {
                  void client.cancelChannelBinding(staleId).catch(() => undefined);
                }
              }}
            >
              {t("users.wizard.retry")}
            </button>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          {inviteId !== null && !TERMINAL.has(stage) ? (
            <>
              <button
                type="button"
                className="rounded border px-3 py-1.5 text-sm"
                onClick={onClose}
              >
                {t("users.wizard.later")}
              </button>
              <button
                type="button"
                className="rounded border px-3 py-1.5 text-sm"
                onClick={() => cancel.mutate()}
              >
                {t("users.wizard.cancel")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm"
              onClick={onClose}
            >
              {t("users.wizard.close")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
