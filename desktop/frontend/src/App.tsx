import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Archive,
  ArrowUpCircle,
  Bot,
  LayoutDashboard,
  Loader2,
  Menu,
  MessageSquare,
  Plug,
} from "lucide-react";
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
import { AppContext, PAGE_LABELS, type Page } from "@/components/app-context";
import { CloudflareAccountCard } from "@/components/cloudflare-account";
import { ErrorAlert, StepList, StateBadge } from "@/components/feedback";
import { toClientError } from "@/services/errors";
import type { ClientService, ConnectionDTO, OperationDTO } from "@/services/types";
import { useUiStore } from "@/store/ui";
import { Diagnostics } from "@/features/diagnostics/Diagnostics";
import { Backup } from "@/features/backup/Backup";
import { Mcp } from "@/features/mcp/Mcp";
import { Models } from "@/features/models/Models";
import { Overview } from "@/features/overview/Overview";
import { Setup } from "@/features/setup/Setup";
import { Updates } from "@/features/updates/Updates";

const Entries = lazy(() =>
  import("@/features/entries/Entries").then((module) => ({ default: module.Entries })),
);

type Session =
  | { kind: "loading" }
  | { kind: "disconnected"; connectionError?: unknown }
  | { kind: "choose" }
  | { kind: "ready"; bootError?: unknown };

const NAV: { page: Page; icon: typeof LayoutDashboard }[] = [
  { page: "overview", icon: LayoutDashboard },
  { page: "models", icon: Bot },
  { page: "mcp", icon: Plug },
  { page: "entries", icon: MessageSquare },
  { page: "diagnostics", icon: Activity },
  { page: "backup", icon: Archive },
  { page: "updates", icon: ArrowUpCircle },
];

export function App({ client }: { client: ClientService }) {
  const [session, setSession] = useState<Session>({ kind: "loading" });
  const [productName, setProductName] = useState("DeskWand Bot");
  const [pending, setPending] = useState<OperationDTO[]>([]);
  const [dirty, setDirtyState] = useState(false);
  const [pendingNav, setPendingNav] = useState<Page | null>(null);
  const [setupImport, setSetupImport] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const { page, setPage } = useUiStore();

  const refresh = useCallback(
    async (showLoading = false) => {
      if (showLoading) setSession({ kind: "loading" });
      try {
        client.name().then(setProductName).catch(() => undefined);
        let connection: ConnectionDTO;
        try {
          connection = await client.cloudflareStatus();
        } catch (error) {
          setSession({ kind: "disconnected", connectionError: error });
          setPending([]);
          return;
        }
        if (connection.state !== "connected") {
          // An expired authorization is not the same as never having
          // connected: say so, and keep the account name so the welcome page
          // can tell the user which account needs re-login.
          const connectionError =
            connection.state === "unavailable"
              ? new Error(
                  "CREDENTIAL_STORE_UNAVAILABLE: 钥匙串不可用，未改用明文保存。",
                )
              : connection.state === "reauth_required"
                ? new Error(
                    `AUTH_REAUTH_REQUIRED: Cloudflare 授权已过期，请重新登录${
                      connection.accountName ? `（${connection.accountName}）` : ""
                    }。`,
                  )
                : undefined;
          setSession({ kind: "disconnected", connectionError });
          setPending([]);
          return;
        }
        const operations = await client.pendingOperations().catch(() => []);
        // The journal outlives a sign-out, so it can still hold operations for
        // a previously connected account. Those cannot be resumed here.
        setPending(
          operations.filter((item) => !item.accountId || item.accountId === connection.accountId),
        );
        try {
          await client.getConfig();
          setSession({ kind: "ready" });
        } catch (error) {
          const code = toClientError(error).code;
          if (code === "TARGET_NOT_SELECTED") {
            setSession({ kind: "choose" });
          } else {
            setSession({ kind: "ready", bootError: error });
          }
        }
      } catch (error) {
        setSession({ kind: "disconnected" });
        setDirtyState(false);
        void error;
      }
    },
    [client],
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

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
    if (result.state === "published") {
      setPending((current) => current.filter((item) => item.operationId !== operation.operationId));
      await refresh();
    }
    return result;
  };

  const abandon = async (operation: OperationDTO) => {
    const result = await client.abandonOperation(operation.operationId);
    if (result.state === "cancelled") {
      setPending((current) => current.filter((item) => item.operationId !== operation.operationId));
    }
    return result;
  };

  const navigateImport = useCallback(() => {
    setSetupImport(true);
  }, []);

  const appValue = useMemo(
    () => ({ client, navigate, navigateImport, setDirty: setDirtyState }),
    [client, navigate, navigateImport],
  );

  const shell = session.kind === "ready";

  return (
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
                  <p className="mt-1 text-xs text-muted-foreground">Cloudflare 管理</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="md:hidden"
                  aria-label={navOpen ? "收起导航" : "打开导航"}
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
                aria-label="主导航"
              >
                {NAV.map(({ page: target, icon: Icon }) => (
                  <Button
                    key={target}
                    type="button"
                    variant={page === target ? "secondary" : "ghost"}
                    className="justify-start"
                    aria-current={page === target ? "page" : undefined}
                    onClick={() => navigate(target)}
                  >
                    <Icon className="size-4" aria-hidden />
                    {PAGE_LABELS[target]}
                  </Button>
                ))}
              </nav>
              <CloudflareAccountCard
                dirty={dirty}
                onSignedOut={() => {
                  // The shell is about to unmount; the import flow lives in the
                  // parent, so it would otherwise survive the next session.
                  setSetupImport(false);
                  void refresh(false);
                }}
              />
            </aside>
          ) : null}

          <main className="min-w-0 flex-1 px-5 py-6 md:px-10 md:py-9">
            {session.kind === "loading" ? (
              <div className="flex min-h-[60svh] items-center justify-center gap-3 text-muted-foreground">
                <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden />
                正在读取状态…
              </div>
            ) : shell && setupImport ? (
              <Setup
                phase="choose"
                initialStep="import"
                onSessionChange={() => refresh(false)}
                onReady={() => {
                  setSetupImport(false);
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
                  {page === "overview" ? <Overview initialError={session.bootError} /> : null}
                  {page === "models" ? <Models /> : null}
                  {page === "mcp" ? <Mcp /> : null}
                  {page === "entries" ? (
                    <Suspense fallback={<PageLoading label="正在加载…" />}>
                      <Entries />
                    </Suspense>
                  ) : null}
                  {page === "diagnostics" ? <Diagnostics /> : null}
                  {page === "backup" ? <Backup /> : null}
                  {page === "updates" ? <Updates /> : null}
                </div>
              </>
            ) : (
              <Setup
                phase={session.kind === "disconnected" ? "disconnected" : "choose"}
                connectionError={
                  session.kind === "disconnected" ? session.connectionError : undefined
                }
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
            <DialogTitle>有未保存的更改</DialogTitle>
            <DialogDescription>
              离开会丢弃未发布的修改，云端不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPendingNav(null)}>
              继续编辑
            </Button>
            <Button type="button" onClick={confirmDiscard}>
              放弃更改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppContext.Provider>
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
            <h2 className="text-sm font-semibold">有未完成的操作</h2>
            <p className="text-xs text-muted-foreground">
              继续前会先核对云端状态。
            </p>
          </div>
          <Badge variant="outline">{operations.length} 项</Badge>
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
              <span>操作 {result.id}</span>
              <StateBadge state={result.state} />
            </div>
            <StepList steps={result.steps ?? []} />
          </div>
        ) : null}
        <ul className="mt-3 space-y-3">
          {operations.map((operation) => (
            <li key={operation.operationId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background p-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="truncate">{operation.workerName || operation.operationId}</span>
                  <StateBadge state={operation.state} />
                  {operation.kind ? <Badge variant="outline">{operation.kind}</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {operation.operationId} · {operation.updatedAt || "时间未知"}
                </p>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => onDismiss(operation.operationId)}>
                  忽略
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={running === operation.operationId}
                  onClick={() => setAbandonTarget(operation)}
                >
                  放弃
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
                  继续
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
          <DialogTitle>确认放弃操作</DialogTitle>
          <DialogDescription>
            只取消本机的待处理记录，云端资源不受影响。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setAbandonTarget(null)}>
            返回
          </Button>
          <Button type="button" variant="destructive" onClick={() => void runAbandon()}>
            确认放弃
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

