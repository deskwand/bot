import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { pageSubtitle, useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/i18n";
import { toClientError } from "@/services/errors";
import type { ChannelDTO } from "@/services/types";
import { AddUserDialog } from "./AddUserDialog";

const UNSUPPORTED = "MEMBERS_UNSUPPORTED";
const MAINTENANCE = "MEMBERS_MAINTENANCE";

export function Users() {
  const t = useT();
  const { client } = useApp();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ["channels"],
    queryFn: () => client.channels(),
    refetchInterval: 30_000,
  });

  const pending = useQuery({
    queryKey: ["member-invites"],
    queryFn: () => client.memberInvites(),
    refetchInterval: 30_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["channels"] });
    void queryClient.invalidateQueries({ queryKey: ["member-invites"] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => client.removeChannel(id),
    onSuccess: refresh,
    onError: (error: unknown) => setActionError(toClientError(error).message),
  });
  const restart = useMutation({
    mutationFn: (id: string) => client.restartChannel(id),
    onSuccess: refresh,
    onError: (error: unknown) => setActionError(toClientError(error).message),
  });
  const [wizard, setWizard] = useState<string | null>(null);
  const rebind = useMutation({
    mutationFn: (id: string) => client.rebindChannel(id),
    onSuccess: (invite) => {
      setWizard(invite.inviteId);
      void refresh();
    },
    onError: (error: unknown) => setActionError(toClientError(error).message),
  });

  const code = users.error === null ? "" : toClientError(users.error).code;
  const rows = users.data?.channels ?? [];

  return (
    <div data-testid="users-page" className="flex flex-col gap-6">
      <PageHeader
        title={t("shell.pages.users")}
        subtitle={pageSubtitle("users")}
        actions={
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            onClick={() => setAdding(true)}
            disabled={code === UNSUPPORTED}
          >
            {t("users.add")}
          </button>
        }
      />

      {code === MAINTENANCE ? (
        <p data-testid="users-maintenance" className="text-sm text-muted-foreground">
          {t("users.maintenance")}
        </p>
      ) : null}
      {code === UNSUPPORTED ? (
        <p data-testid="users-unsupported" className="text-sm text-muted-foreground">
          {t("users.unsupported")}
        </p>
      ) : null}
      {users.error !== null && code !== UNSUPPORTED && code !== MAINTENANCE ? (
        <p className="text-sm text-muted-foreground">{toClientError(users.error).message}</p>
      ) : null}
      {actionError === null ? null : <ErrorAlert error={actionError} />}

      {(pending.data?.invites ?? []).filter((invite) => invite.expiresAt > Date.now())
        .length ? (
        <section data-testid="users-pending" className="rounded border p-3">
          <h2 className="mb-2 text-sm font-medium">{t("users.pending")}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {(pending.data?.invites ?? [])
              .filter((invite) => invite.expiresAt > Date.now())
              .map((invite) => (
              <li key={invite.inviteId} className="flex items-center justify-between gap-3">
                <span>{invite.label}</span>
                <button
                  type="button"
                  className="rounded border px-2 py-0.5 text-xs"
                  onClick={() => setWizard(invite.inviteId)}
                >
                  {t("users.resume")}
                </button>
              </li>
              ))}
          </ul>
        </section>
      ) : null}

      {users.isPending ? (
        <p className="text-sm text-muted-foreground">{t("shell.readingStatus")}</p>
      ) : rows.length === 0 && code === "" ? (
        <p className="text-sm text-muted-foreground">{t("users.empty")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-2">{t("users.columns.label")}</th>
              <th className="py-2">{t("users.columns.account")}</th>
              <th className="py-2">{t("users.columns.connection")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((user: ChannelDTO) => {
              const needsReset = user.state === "needs_reset";
              return (
                <tr key={user.channelId} data-testid={`user-row-${user.channelId}`} className="border-t">
                  <td className="py-2">{user.label}</td>
                  <td className="py-2">{user.account ?? "—"}</td>
                  <td className="py-2">
                    {needsReset ? (
                      <Badge variant="outline">{t("users.connection.needs_reset")}</Badge>
                    ) : (
                      <span>{user.state}</span>
                    )}
                    {user.lastErrorCode === null ? null : (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {user.lastErrorCode}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex justify-end gap-2">
                      {needsReset ? (
                        <button
                          type="button"
                          data-testid={`restart-${user.channelId}`}
                          className="rounded border px-2 py-0.5 text-xs"
                          onClick={() => restart.mutate(user.channelId)}
                        >
                          {t("users.actions.restart")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        data-testid={`rebind-${user.channelId}`}
                        className="rounded border px-2 py-0.5 text-xs"
                        onClick={() => rebind.mutate(user.channelId)}
                      >
                        {t("users.actions.rebind")}
                      </button>
                      <button
                        type="button"
                        data-testid={`revoke-${user.channelId}`}
                        className="rounded border px-2 py-0.5 text-xs"
                        onClick={() => remove.mutate(user.channelId)}
                      >
                        {t("users.actions.revoke")}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {adding || wizard !== null ? (
        <AddUserDialog
          {...(wizard === null ? {} : { resumeInviteId: wizard })}
          onClose={() => {
            setAdding(false);
            setWizard(null);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
