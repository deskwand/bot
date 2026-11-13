import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  Archive,
  Brain,
  Cloud,
  Eye,
  Hand,
  HeartPulse,
  KeyRound,
  Loader2,
  Menu,
  MessageSquare,
  Server as ServerIcon,
  Sprout,
  Stethoscope,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AppContext, pageLabel, type Page } from "@/components/app-context";
import { ContainerFooter } from "@/components/cloudflare-account";
import { TelemetryToggle } from "@/components/telemetry-toggle";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { LocaleChoice } from "@/components/locale-choice";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ErrorAlert, StepList, StateBadge } from "@/components/feedback";
import { useLocale, useT } from "@/i18n";
import { createAppQueryClient } from "@/services/queries";
import type { ClientService, OperationDTO } from "@/services/types";
import { useUiStore } from "@/store/ui";
import { Diagnostics } from "@/features/diagnostics/Diagnostics";
import { Backup } from "@/features/backup/Backup";
import { Mcp } from "@/features/mcp/Mcp";
import { Models } from "@/features/models/Models";
import { Overview } from "@/features/overview/Overview";
import { Exchanges } from "@/features/exchanges/Exchanges";
import { Agent } from "@/features/agent/Agent";
import { Cloudflare } from "@/features/cloudflare/Cloudflare";
import { Search } from "@/features/search/Search";
import { Setup } from "@/features/setup/Setup";
import { Server } from "@/features/server/Server";
import { Unsupported } from "@/components/unsupported";
import { Updates } from "@/features/updates/Updates";

const Entries = lazy(() =>
  import("@/features/entries/Entries").then((module) => ({ default: module.Entries })),
);

type ConnectionFailure =
  | { code: string; accountName?: string }
  | { error: unknown };

type Session =
  | { kind: "loading" }
  | { kind: "disconnected"; connectionFailure?: ConnectionFailure }
  | { kind: "choose" }
  | { kind: "ready" };

type NavGroup = "mind" | "senses" | "action" | "livelihood" | "containers";

const NAV_GROUPS: { group?: NavGroup; items: { page: Page; icon: LucideIcon }[] }[] = [
  { items: [{ page: "overview", icon: HeartPulse }] },
  { group: "mind", items: [{ page: "models", icon: Brain }] },
  {
    group: "senses",
    items: [
      { page: "search", icon: Eye },
      { page: "entries", icon: MessageSquare },
    ],
  },
  { group: "action", items: [{ page: "mcp", icon: Hand }] },
  {
    group: "livelihood",
    items: [
      { page: "agent", icon: Wallet },
      { page: "exchange", icon: KeyRound },
    ],
  },
  {
    group: "containers",
    items: [
      { page: "diagnostics", icon: Stethoscope },
      { page: "backup", icon: Archive },
      { page: "updates", icon: Sprout },
    ],
  },
];

const CONTAINER_UNSUPPORTED: Page[] = ["backup", "updates"];

export function App({ client }: { client: ClientService }) {
  const t = useT();
  const { resolved: locale } = useLocale();
  const refreshRef = useRef<(showLoading?: boolean) => Promise<void>>(async () => {});
  const [queryClient] = useState(() => createAppQueryClient(() => void refreshRef.current(false)));
  const scopeRef = useRef<string | null>(null);
  const [session, setSession] = useState<Session>({ kind: "loading" });
  const [productName, setProductName] = useState("DeskWand Bot");
  const [targetKind, setTargetKind] = useState("");
  const [pending, setPending] = useState<OperationDTO[]>([]);
  const [dirty, setDirtyState] = useState(false);
  const [pendingNav, setPendingNav] = useState<Page | null>(null);
  const [setupImport, setSetupImport] = useState(false);
  // Whether this Mac can host the bot itself. A boot state that has not been
  // read yet offers no local option rather than one that would fail.
  const [localSupported, setLocalSupported] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const { page, setPage } = useUiStore();

  const refresh = useCallback(
    async (showLoading = false) => {
      if (showLoading) setSession({ kind: "loading" });
      try {
        client.name().then(setProductName).catch(() => undefined);
        const boot = await client.bootState();
        const connection = boot.connection;
        const scope = `${boot.targetKind}:${connection.accountId ?? ""}:${boot.targetName}`;
        if (scopeRef.current !== null && scopeRef.current !== scope) {
          // Cached queries are keyed only by resource, so a different account
          // or deployment must not inherit the previous one's data. Unmount the
          // old shell before dropping what its pages are showing.
          await queryClient.cancelQueries();
          setSession({ kind: "loading" });
          queryClient.clear();
        }
        scopeRef.current = scope;
        setTargetKind(boot.targetKind);
        setLocalSupported(boot.localSupported);
        setPending(boot.pending);
        if (boot.targetKind === "container") {
          // A container target is local to this app: it needs no Cloudflare
          // login, only the host recorded in the target file.
          setSession({ kind: "ready" });
          return;
        }
        if (connection.state !== "connected") {
          // An expired authorization is not the same as never having
          // connected: say so, and keep the account name so the welcome page
          // can tell the user which account needs re-login.
          // Keep only the data here; the line is built at render time so it
          // follows a language switch made before signing in.
          const connectionFailure: ConnectionFailure | undefined =
            connection.state === "unavailable"
              ? { code: "CREDENTIAL_STORE_UNAVAILABLE" }
              : connection.state === "reauth_required"
                ? {
                    code: "AUTH_REAUTH_REQUIRED",
                    accountName: connection.accountName || undefined,
                  }
                : undefined;
          setSession({ kind: "disconnected", connectionFailure });
          return;
        }
        setSession(
          boot.targetSelected && !boot.targetMismatch
            ? { kind: "ready" }
            : { kind: "choose" },
        );
      } catch (error) {
        setSession({ kind: "disconnected", connectionFailure: { error } });
        setPending([]);
        setDirtyState(false);
      }
    },
    [client, queryClient],
  );
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const lastLocale = useRef<string | null>(null);
  useEffect(() => {
    // Server-rendered copy (diagnostics, catalogs, status) is cached by query
    // key, so a language switch has to fetch it again.
    if (lastLocale.current === null) {
      lastLocale.current = locale;
      return;
    }
    if (lastLocale.current === locale) return;
    lastLocale.current = locale;
    void queryClient.invalidateQueries();
  }, [locale, queryClient]);

  const navigate = useCallback(
    (next: Page) => {
      setNavOpen(false);
      if (next === page) return;
      if (dirty) {
        setPendingNav(next);
        return;
      }
      setPage(next);
    },
    [dirty, page, setPage],
  );

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const confirmDiscard = () => {
    const next = pendingNav;
    setDirtyState(false);
    setPendingNav(null);
    if (next) setPage(next);
  };

  const resume = async (operation: OperationDTO) => {
    const result = await client.resumeOperation(operation.operationId);
    void queryClient.invalidateQueries();
    if (result.state === "published") {
      setPending((current) => current.filter((item) => item.operationId !== operation.operationId));
      await refresh();
    }
    return result;
  };

  const abandon = async (operation: OperationDTO) => {
    const result = await client.abandonOperation(operation.operationId);
    void queryClient.invalidateQueries();
    if (result.state === "cancelled") {
      setPending((current) => current.filter((item) => item.operationId !== operation.operationId));
    }
    return result;
  };

  const navigateImport = useCallback(() => {
    setSetupImport(true);
  }, []);

  const signedOut = useCallback(() => {
    // The shell is about to unmount; the import flow lives in the parent, so it
    // would otherwise survive the next session. The next session opens on the
    // living entity's vitals.
    setSetupImport(false);
    setPage("overview");
    void refresh(false);
  }, [refresh, setPage]);

  const appValue = useMemo(
    () => ({ client, targetKind, refresh, navigate, navigateImport, setDirty: setDirtyState, signedOut }),
    [client, targetKind, refresh, navigate, navigateImport, signedOut],
  );

  const isContainer = targetKind === "container";
  // 服务器页只属于容器、Cloudflare 页只属于 Cloudflare：切换运行方式后停在
  // 另一个目标的分区页上会渲染出一片空白。回到生命体征。
  useEffect(() => {
    if (isContainer && page === "cloudflare") setPage("overview");
    if (!isContainer && page === "server") setPage("overview");
  }, [isContainer, page, setPage]);
  const nav = useMemo(() => {
    const containerItem = isContainer
      ? { page: "server" as Page, icon: ServerIcon }
      : { page: "cloudflare" as Page, icon: Cloud };
    return NAV_GROUPS.map(({ group, items }) => ({
      group,
      items:
        group === "containers"
          ? [containerItem, ...items]
          : items,
    }));
  }, [isContainer]);
  const unsupported = isContainer && CONTAINER_UNSUPPORTED.includes(page);

  const shell = session.kind === "ready";
  const connectionFailure =
    session.kind === "disconnected" ? session.connectionFailure : undefined;
  const connectionError =
    connectionFailure && "code" in connectionFailure
      ? new Error(`${connectionFailure.code}: `)
      : connectionFailure?.error;
  const connectionAccount =
    connectionFailure && "code" in connectionFailure
      ? connectionFailure.accountName
      : undefined;

  return (
    <QueryClientProvider client={queryClient}>
      <AppContext.Provider value={appValue}>
      <div className="min-h-svh bg-muted/40 text-foreground">
        <div className="mx-auto flex min-h-svh max-w-7xl flex-col md:flex-row">
          {shell ? (
            <aside className="flex w-full shrink-0 flex-col border-b border-border bg-sidebar p-4 md:w-56 md:border-r md:border-b-0 md:p-6">
              <div className="mb-6 flex items-center justify-between md:block">
                <div>
                  <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                    <span aria-hidden className="text-primary">◈</span>
                    {productName}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="md:hidden"
                  aria-label={navOpen ? t("shell.closeNav") : t("shell.openNav")}
                  aria-expanded={navOpen}
                  aria-controls="primary-nav"
                  onClick={() => setNavOpen((open) => !open)}
                >
                  <Menu />
                </Button>
              </div>
              <nav
                id="primary-nav"
                className={`${navOpen ? "flex" : "hidden"} flex-col gap-1 md:flex`}
                aria-label={t("shell.nav")}
              >
                {nav.map(({ group, items }) => {
                  const buttons = items.map(({ page: target, icon: Icon }) => (
                    <Button
                      key={target}
                      type="button"
                      variant={page === target ? "secondary" : "ghost"}
                      className="justify-start"
                      aria-current={page === target ? "page" : undefined}
                      onClick={() => navigate(target)}
                    >
                      <Icon className="size-4" aria-hidden />
                      {pageLabel(target)}
                    </Button>
                  ));
                  if (!group) {
                    return (
                      <div key="ungrouped" className="flex flex-col gap-1">
                        {buttons}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={group}
                      role="group"
                      aria-labelledby={`nav-group-${group}`}
                      className="mt-4 flex flex-col gap-1"
                    >
                      <h2
                        id={`nav-group-${group}`}
                        className="px-3 text-xs font-medium text-muted-foreground"
                      >
                        {t(`shell.groups.${group}`)}
                      </h2>
                      {buttons}
                    </div>
                  );
                })}
              </nav>
              <div className="mt-6 md:mt-auto">
                <ThemeSwitcher />
                <LocaleSwitcher dirty={dirty} />
                <TelemetryToggle />
                <ContainerFooter />
              </div>
            </aside>
          ) : null}

          <main className="min-w-0 flex-1 px-5 py-6 md:px-8 md:py-8">
            {!shell ? (
              <div className="mb-4 flex justify-end">
                <LocaleChoice />
              </div>
            ) : null}
            {session.kind === "loading" ? (
              <div className="flex min-h-[60svh] items-center justify-center gap-3 text-muted-foreground">
                <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden />
                {t("shell.readingStatus")}
              </div>
            ) : shell && setupImport ? (
              <Setup
                phase="choose"
                localSupported={localSupported}
                initialStep="import"
                onSessionChange={() => refresh(false)}
                onReady={() => {
                  setSetupImport(false);
                  void queryClient.invalidateQueries();
                  void refresh(false);
                }}
              />
            ) : shell ? (
              <>
                <PendingOperations
                  operations={pending}
                  onResume={resume}
                  onAbandon={abandon}
                  onDismiss={(id) =>
                    setPending((current) => current.filter((item) => item.operationId !== id))
                  }
                />
                <div
                  key={page}
                  className="animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
                >
                  {unsupported ? <Unsupported /> : null}
                  {!unsupported && page === "overview" ? <Overview /> : null}
                  {page === "models" ? <Models /> : null}
                  {page === "search" ? <Search /> : null}
                  {page === "exchange" ? <Exchanges /> : null}
                  {page === "agent" ? <Agent /> : null}
                  {page === "mcp" ? <Mcp /> : null}
                  {page === "entries" ? (
                    <Suspense fallback={<PageLoading label={t("shell.pageLoading")} />}>
                      <Entries />
                    </Suspense>
                  ) : null}
                  {page === "diagnostics" ? <Diagnostics /> : null}
                  {page === "backup" && !isContainer ? <Backup /> : null}
                  {page === "updates" && !isContainer ? <Updates /> : null}
                  {page === "cloudflare" && !isContainer ? <Cloudflare /> : null}
                  {page === "server" && isContainer ? <Server /> : null}
                </div>
              </>
            ) : (
              <Setup
                phase={session.kind === "disconnected" ? "disconnected" : "choose"}
                localSupported={localSupported}
                connectionError={connectionError}
                connectionAccount={connectionAccount}
                onSessionChange={() => refresh(false)}
                onReady={() => refresh(false)}
              />
            )}
          </main>
        </div>
      </div>

      <Dialog open={pendingNav !== null} onOpenChange={(open) => !open && setPendingNav(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("shell.unsavedTitle")}</DialogTitle>
            <DialogDescription>{t("shell.unsavedDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingNav(null)}>
              {t("shell.keepEditing")}
            </Button>
            <Button type="button" onClick={confirmDiscard}>
              {t("shell.discardChanges")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </AppContext.Provider>
    </QueryClientProvider>
  );
}

function PageLoading({ label }: { label: string }) {
  return (
    <div className="flex min-h-[30svh] items-center justify-center gap-2 text-muted-foreground">
      <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
      {label}
    </div>
  );
}

function PendingOperations({
  operations,
  onResume,
  onAbandon,
  onDismiss,
}: {
  operations: OperationDTO[];
  onResume: (operation: OperationDTO) => Promise<unknown>;
  onAbandon: (operation: OperationDTO) => Promise<unknown>;
  onDismiss: (id: string) => void;
}) {
  const t = useT();
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ id: string; state: string; steps: OperationDTO["steps"] } | null>(null);
  const [abandonTarget, setAbandonTarget] = useState<OperationDTO | null>(null);

  const runAbandon = async () => {
    const operation = abandonTarget;
    if (!operation) return;
    setAbandonTarget(null);
    setError(null);
    setRunning(operation.operationId);
    try {
      const value = await onAbandon(operation);
      const typed = value as { state?: string; steps?: OperationDTO["steps"] };
      setResult({ id: operation.operationId, state: typed.state ?? "", steps: typed.steps });
    } catch (cause) {
      setError(cause);
    } finally {
      setRunning(null);
    }
  };

  if (operations.length === 0) return null;

  return (
    <>
    <Card
      data-testid="pending-operations"
      className="mb-6 border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20"
    >
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">{t("shell.pendingTitle")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("shell.pendingDescription")}
            </p>
          </div>
          <Badge variant="outline">
            {t("shell.pendingCount", { count: operations.length })}
          </Badge>
        </div>
        {error ? (
          <ErrorAlert
            error={error}
            onRetry={() => {
              const first = operations[0];
              if (!first) return;
              setError(null);
              setRunning(first.operationId);
              void onResume(first)
                .then((value) => {
                  const typed = value as { state?: string; steps?: OperationDTO["steps"] };
                  setResult({ id: first.operationId, state: typed.state ?? "", steps: typed.steps });
                })
                .catch(setError)
                .finally(() => setRunning(null));
            }}
          />
        ) : null}
        {result ? (
          <div className="my-2 rounded-md border border-border bg-background p-3 text-sm">
            <div className="flex items-center gap-2">
              <span>{t("shell.operationLabel", { id: result.id })}</span>
              <StateBadge state={result.state} />
            </div>
            {result.state === "published" || result.state === "completed" ? <details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">{t("common.details")}</summary><StepList steps={result.steps ?? []} /></details> : <StepList steps={result.steps ?? []} />}
          </div>
        ) : null}
        <ul className="mt-3 space-y-3">
          {operations.map((operation) => (
            <li key={operation.operationId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background p-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="truncate" data-i18n-ignore>{operation.workerName || operation.operationId}</span>
                  <StateBadge state={operation.state} />
                  {operation.kind ? <Badge variant="outline">{operation.kind}</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  <span data-i18n-ignore>{operation.operationId}</span> ·{" "}
                  {operation.updatedAt || t("shell.timeUnknown")}
                </p>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => onDismiss(operation.operationId)}>
                  {t("shell.ignore")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={running === operation.operationId}
                  onClick={() => setAbandonTarget(operation)}
                >
                  {t("shell.abandon")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  data-testid="pending-resume"
                  disabled={running === operation.operationId}
                  onClick={() => {
                    setError(null);
                    setRunning(operation.operationId);
                    void onResume(operation)
                      .then((value) => {
                        const typed = value as { state?: string; steps?: OperationDTO["steps"] };
                        setResult({ id: operation.operationId, state: typed.state ?? "", steps: typed.steps });
                      })
                      .catch(setError)
                      .finally(() => setRunning(null));
                  }}
                >
                  {running === operation.operationId ? (
                    <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : null}
                  {t("common.continue")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
    <Dialog open={abandonTarget !== null} onOpenChange={(open) => !open && setAbandonTarget(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("shell.abandonTitle")}</DialogTitle>
          <DialogDescription>{t("shell.abandonDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setAbandonTarget(null)}>
            {t("shell.back")}
          </Button>
          <Button type="button" variant="destructive" onClick={() => void runAbandon()}>
            {t("shell.confirmAbandon")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

