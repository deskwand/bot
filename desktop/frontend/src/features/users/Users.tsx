import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { pageSubtitle, useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/i18n";
import { toClientError } from "@/services/errors";
import type { MemberUserDTO } from "@/services/types";
import { AddUserDialog } from "./AddUserDialog";

const UNSUPPORTED = "MEMBERS_UNSUPPORTED";
const MAINTENANCE = "MEMBERS_MAINTENANCE";

function connectionLabel(t: ReturnType<typeof useT>, user: MemberUserDTO): string {
  const key = `users.connection.${user.connection}` as const;
  const label = t(key as never);
  return label === key ? user.connection : label;
}

export function Users() {
  const t = useT();
  const { client } = useApp();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ["members"],
    queryFn: () => client.members(),
    refetchInterval: 30_000,
  });

  const pending = useQuery({
    queryKey: ["member-invites"],
    queryFn: () => client.memberInvites(),
    refetchInterval: 30_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["members"] });
    void queryClient.invalidateQueries({ queryKey: ["member-invites"] });
  };

  const revoke = useMutation({
    mutationFn: (id: string) => client.revokeMember(id),
    onSuccess: refresh,
    onError: (error: unknown) => setActionError(toClientError(error).message),
  });
  const [wizard, setWizard] = useState<string | null>(null);
  const rebind = useMutation({
    mutationFn: (id: string) => client.rebindMember(id),
    onSuccess: (invite) => {
      setWizard(invite.inviteId);
      void refresh();
    },
    onError: (error: unknown) => setActionError(toClientError(error).message),
  });

  const code = users.error === null ? "" : toClientError(users.error).code;
  const rows = users.data?.users ?? [];

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

      {pending.data?.invites.length ? (
        <section data-testid="users-pending" className="rounded border p-3">
          <h2 className="mb-2 text-sm font-medium">{t("users.pending")}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {pending.data.invites.map((invite) => (
              <li key={invite.inviteId} className="flex items-center justify-between gap-3">
                <span>{invite.label}</span>
                <button
                  type="button"
                  className="rounded border px-2 py-0.5 text-xs"
                  onClick={() => setWizard(invite.inviteId)}
                >
                  {t("users.wizard.title")}
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
              <th className="py-2">{t("users.columns.role")}</th>
              <th className="py-2">{t("users.columns.connection")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((user) => {
              const revoked = user.status === "revoked";
              return (
                <tr key={user.memberId} data-testid={`user-row-${user.memberId}`} className="border-t">
                  <td className="py-2">{user.label}</td>
                  <td className="py-2">
                    {user.role === "owner" ? t("users.role.owner") : t("users.role.member")}
                  </td>
                  <td className="py-2">
                    {revoked ? (
                      <Badge variant="outline">{t("users.status.revoked")}</Badge>
                    ) : (
                      <span>{connectionLabel(t, user)}</span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {user.role === "owner" || revoked ? null : (
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          data-testid={`rebind-${user.memberId}`}
                          className="rounded border px-2 py-0.5 text-xs"
                          onClick={() => rebind.mutate(user.memberId)}
                        >
                          {t("users.actions.rebind")}
                        </button>
                        <button
                          type="button"
                          data-testid={`revoke-${user.memberId}`}
                          className="rounded border px-2 py-0.5 text-xs"
                          onClick={() => revoke.mutate(user.memberId)}
                        >
                          {t("users.actions.revoke")}
                        </button>
                      </div>
                    )}
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
