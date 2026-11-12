import { PageHeader } from "@/components/page-header";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { pageSubtitle, useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { SyncStatus } from "@/components/sync-status";
import { useDirty } from "@/components/use-dirty";
import { useT } from "@/i18n";
import { toClientError } from "@/services/errors";
import { useConfigQuery, useInvalidate, useMcpCatalogQuery } from "@/services/queries";
import type { ConfigDTO, McpAddInput, McpProbeDTO, McpToolDTO } from "@/services/types";
import { McpAddDialog } from "./McpAddDialog";
import { ApprovalModeSwitch } from "./ApprovalModeSwitch";
import { McpToolList } from "./McpToolList";

const AUTH_POLL_MS = 2000;
const AUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const TOOL_WARNING_THRESHOLD = 100;

interface McpServerConfig {
  name: string;
  url: string;
  description?: string;
  catalogId?: string;
  oauth?: boolean;
  enabled?: boolean;
  approvalPolicy?: "writes";
  autoApprove?: string[];
  requireApproval?: string[];
  disabledTools?: string[];
  [key: string]: unknown;
}

function parseServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is McpServerConfig =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { name?: unknown }).name === "string",
  );
}

function authMap(statuses: { name: string; state: string }[]): Record<string, string> {
  return Object.fromEntries(statuses.map((status) => [status.name, status.state]));
}

function isAdminUnavailable(error: unknown): boolean {
  return toClientError(error).code === "MCP_ADMIN_UNAVAILABLE";
}

export function Mcp() {
  const { client } = useApp();
  const t = useT();
  const configQuery = useConfigQuery();
  const catalogQuery = useMcpCatalogQuery();
  const invalidate = useInvalidate();
  const catalog = catalogQuery.data ?? [];
  const ready = Boolean(configQuery.data) && !configQuery.isPlaceholder;
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [auth, setAuth] = useState<Record<string, string>>({});
  const [probes, setProbes] = useState<Record<string, McpProbeDTO>>({});
  const [drafts, setDrafts] = useState<Record<string, McpToolDTO[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [pendingAuth, setPendingAuth] = useState<string[]>([]);
  const [adminError, setAdminError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [savingTools, setSavingTools] = useState<string | null>(null);

  const applyProbe = useCallback((name: string, result: McpProbeDTO) => {
    setProbes((current) => ({ ...current, [name]: result }));
    if (result.ok) {
      setDrafts((current) => ({ ...current, [name]: result.tools }));
    }
  }, []);

  const refresh = useCallback(
    async (list: McpServerConfig[]) => {
      try {
        const statuses = await client.mcpStatus();
        setAuth(authMap(statuses));
        const enabled = list.filter((server) => server.enabled !== false);
        const settled = await Promise.allSettled(
          enabled.map(async (server) => ({
            name: server.name,
            result: await client.probeMcp(server.name),
          })),
        );
        let adminFailure: unknown = null;
        for (const item of settled) {
          if (item.status === "fulfilled") {
            applyProbe(item.value.name, item.value.result);
          } else if (isAdminUnavailable(item.reason)) {
            adminFailure = item.reason;
          }
        }
        if (adminFailure) setAdminError(adminFailure);
      } catch (cause) {
        if (isAdminUnavailable(cause)) {
          setAdminError(cause);
        } else {
          setError(cause);
        }
      }
    },
    [applyProbe, client],
  );

  const initialized = useRef(false);
  const configData = configQuery.data;
  const loading = !configData && configQuery.isFetching;
  const loadError = configData ? null : configQuery.error;
  const catalogError =
    catalogQuery.error && !catalogQuery.data ? catalogQuery.error : null;

  const reload = async () => {
    setAdminError(null);
    setError(null);
    const result = (await configQuery.refetch()) as { data?: ConfigDTO } | undefined;
    await catalogQuery.refetch();
    if (result?.data) await refresh(parseServers(result.data.mcpServers));
  };

  useEffect(() => {
    if (!configData) return;
    setServers(parseServers(configData.mcpServers));
  }, [configData]);

  useEffect(() => {
    if (!configData || configQuery.isPlaceholder || initialized.current) return;
    initialized.current = true;
    void refresh(parseServers(configData.mcpServers));
  }, [configData, configQuery.isPlaceholder, refresh]);

  useEffect(() => {
    if (pendingAuth.length === 0) return;
    const deadline = Date.now() + AUTH_POLL_TIMEOUT_MS;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() > deadline) {
        setPendingAuth([]);
        return;
      }
      try {
        const statuses = await client.mcpStatus();
        if (cancelled) return;
        setAuth(authMap(statuses));
        const ready = pendingAuth.filter((name) =>
          statuses.some((status) => status.name === name && status.state === "ok"),
        );
        if (ready.length === 0) return;
        setPendingAuth((current) => current.filter((name) => !ready.includes(name)));
        const settled = await Promise.allSettled(
          ready.map(async (name) => ({
            name,
            result: await client.probeMcp(name),
          })),
        );
        if (cancelled) return;
        for (const item of settled) {
          if (item.status === "fulfilled") {
            applyProbe(item.value.name, item.value.result);
          }
        }
      } catch (cause) {
        if (isAdminUnavailable(cause)) {
          setAdminError(cause);
          setPendingAuth([]);
        }
      }
    };
    const timer = window.setInterval(() => void tick(), AUTH_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyProbe, client, pendingAuth]);

  const dirtyServers = useMemo(
    () =>
      servers.filter((server) => {
        const probe = probes[server.name];
        const draft = drafts[server.name];
        if (!probe?.ok || !draft) return false;
        const original = new Map(probe.tools.map((tool) => [tool.name, tool.mode]));
        return draft.some((tool) => original.get(tool.name) !== tool.mode);
      }),
    [drafts, probes, servers],
  );
  useDirty(dirtyServers.length > 0);

  const enabledToolCount = useMemo(
    () =>
      servers.reduce((total, server) => {
        if (server.enabled === false) return total;
        const probe = probes[server.name];
        if (!probe?.ok) return total;
        return total + probe.tools.filter((tool) => tool.mode !== "disabled").length;
      }, 0),
    [probes, servers],
  );

  const addServer = async (input: McpAddInput) => {
    setAddError(null);
    try {
      await client.addMcpServer(input);
      invalidate.mcp();
      const result = (await configQuery.refetch()) as { data?: ConfigDTO } | undefined;
      const list = result?.data
        ? parseServers(result.data.mcpServers)
        : servers;
      setServers(list);
      const entry = catalog.find((item) => item.id === input.catalogId);
      if (entry?.oauth || input.custom?.oauth) {
        setAuth((current) => ({ ...current, [input.name]: "unauthorized" }));
        setPendingAuth((current) =>
          current.includes(input.name) ? current : [...current, input.name],
        );
        try {
          await client.startMcpOAuth(input.name);
        } catch (cause) {
          setError(cause);
        }
      }
      await refresh(list);
    } catch (cause) {
      setAddError(cause);
      throw cause;
    }
  };

  const toggleServer = async (server: McpServerConfig) => {
    setBusy(server.name);
    setError(null);
    const next: McpServerConfig = {
      ...server,
      enabled: server.enabled === false,
    };
    try {
      await client.updateMcpServer(server.name, next, []);
      setServers((current) =>
        current.map((entry) => (entry.name === server.name ? next : entry)),
      );
      invalidate.mcp();
      if (next.enabled !== false) {
        applyProbe(server.name, await client.probeMcp(server.name));
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };

  const removeServer = async (server: McpServerConfig) => {
    setBusy(server.name);
    setError(null);
    try {
      await client.removeMcpServer(server.name);
      setServers((current) => current.filter((entry) => entry.name !== server.name));
      setProbes((current) => {
        const next = { ...current };
        delete next[server.name];
        return next;
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[server.name];
        return next;
      });
      setAuth((current) => {
        const next = { ...current };
        delete next[server.name];
        return next;
      });
      setPendingAuth((current) => current.filter((name) => name !== server.name));
      invalidate.mcp();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };

  const relogin = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      await client.startMcpOAuth(name);
      setPendingAuth((current) => (current.includes(name) ? current : [...current, name]));
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };

  const changeTool = (name: string, toolName: string, mode: string) => {
    setDrafts((current) => ({
      ...current,
      [name]: (current[name] ?? []).map((tool) =>
        tool.name === toolName ? { ...tool, mode } : tool,
      ),
    }));
  };

  // The review mode is the default for write tools and is not written to any
  // list, so only auto, approval and disabled need to be collected here.
  // A destructive tool is probed as approval in reviewed mode without being in
  // requireApproval; writing it there would pin it to approval even after the
  // owner switches to autonomous mode. So approval is only written for tools
  // already forced or that the owner changed to approval here.
  const saveTools = async (server: McpServerConfig) => {
    const tools = drafts[server.name] ?? [];
    const probed = new Map(
      (probes[server.name]?.ok ? probes[server.name]!.tools : []).map((tool) => [
        tool.name,
        tool.mode,
      ]),
    );
    const forced = new Set(server.requireApproval ?? []);
    const next: McpServerConfig = {
      ...server,
      autoApprove: tools.filter((tool) => tool.mode === "auto").map((tool) => tool.name),
      requireApproval: tools
        .filter(
          (tool) =>
            tool.mode === "approval" &&
            (forced.has(tool.name) || probed.get(tool.name) !== "approval"),
        )
        .map((tool) => tool.name),
      disabledTools: tools
        .filter((tool) => tool.mode === "disabled")
        .map((tool) => tool.name),
    };
    setSavingTools(server.name);
    setError(null);
    try {
      await client.updateMcpServer(server.name, next, []);
      setServers((current) =>
        current.map((entry) => (entry.name === server.name ? next : entry)),
      );
      setProbes((current) => ({
        ...current,
        [server.name]: { ok: true, tools: tools.map((tool) => ({ ...tool })) },
      }));
      invalidate.mcp();
    } catch (cause) {
      setError(cause);
    } finally {
      setSavingTools(null);
    }
  };

  const toggleExpanded = (name: string) => {
    setExpanded((current) =>
      current.includes(name)
        ? current.filter((entry) => entry !== name)
        : [...current, name],
    );
  };

  const header = (
    <PageHeader title={t("shell.pages.mcp")} subtitle={pageSubtitle("mcp")} actions={<>
      <SyncStatus
        isFetching={configQuery.isFetching}
        isPlaceholder={configQuery.isPlaceholder}
        savedAt={configQuery.savedAt}
        error={configData ? configQuery.error : null}
        onRetry={() => void reload()}
      />
      <Button
        type="button"
        onClick={() => setAddOpen(true)}
        disabled={loading || !catalog.length || !ready}
      >
        <Plus aria-hidden />
        {t("mcp.addService")}
      </Button>
</>} />
  );

  if (loading) {
    return (
      <div>
        {header}
        <div className="flex min-h-[30svh] items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
          {t("mcp.loading")}
        </div>
      </div>
    );
  }

  if (adminError) {
    return (
      <div>
        {header}
        <Alert variant="destructive" className="my-4" data-testid="mcp-admin-unavailable">
          <AlertTitle>{t("mcp.adminUnavailable")}</AlertTitle>
          <AlertDescription>
            <span className="block" data-i18n-ignore>{toClientError(adminError).message}</span>
            <span className="mt-3 flex">
              <Button type="button" size="sm" onClick={() => void reload()}>
                {t("common.retry")}
              </Button>
            </span>
          </AlertDescription>
        </Alert>
        <ErrorAlert error={catalogError} onRetry={() => void reload()} />
      </div>
    );
  }

  return (
    <div>
      {header}

      <ErrorAlert error={loadError} onRetry={() => void reload()} />
      <ErrorAlert error={catalogError} onRetry={() => void reload()} />
      <ErrorAlert error={error} />
      {configData ? (
        <ApprovalModeSwitch
          config={configData}
          disabled={!ready || !configData.configPresent}
          onPublished={reload}
          onError={setError}
        />
      ) : null}
      {enabledToolCount > TOOL_WARNING_THRESHOLD ? (
        <Alert className="my-4" data-testid="mcp-tool-warning">
          <AlertTitle>{t("mcp.tooManyToolsTitle")}</AlertTitle>
          <AlertDescription>
            {t("mcp.tooManyToolsDescription")}
          </AlertDescription>
        </Alert>
      ) : null}

      {servers.length === 0 ? (
        <Card className="mt-5">
          <CardContent className="py-6 text-sm text-muted-foreground">
            {t("mcp.empty")}
          </CardContent>
        </Card>
      ) : (
        <div className="mt-5 space-y-3">
          {servers.map((server) => {
            const probe = probes[server.name];
            const tools = drafts[server.name] ?? probe?.tools ?? [];
            const reviewable = new Set(
              (probe?.ok ? probe.tools : [])
                .filter((tool) => tool.mode === "review")
                .map((tool) => tool.name),
            );
            const enabled = server.enabled !== false;
            const needsAuth =
              auth[server.name] === "unauthorized" ||
              auth[server.name] === "needs_reauth" ||
              (server.oauth === true &&
                probe !== undefined &&
                !probe.ok &&
                Boolean(probe.auth) &&
                probe.auth !== "ok");
            const status = !enabled
              ? { label: t("mcp.status.disabled"), variant: "outline" as const, failed: false }
              : auth[server.name] === "needs_reauth"
                ? { label: t("mcp.status.needsReauth"), variant: "destructive" as const, failed: false }
                : auth[server.name] === "unauthorized"
                  ? { label: t("mcp.status.unauthorized"), variant: "outline" as const, failed: false }
                  : probe && !probe.ok
                    ? { label: t("mcp.status.failed"), variant: "destructive" as const, failed: true }
                    : probe?.ok
                      ? { label: t("mcp.status.ok"), variant: "secondary" as const, failed: false }
                      : { label: t("mcp.status.probing"), variant: "outline" as const, failed: false };
            const enabledCount = probe?.ok
              ? probe.tools.filter((tool) => tool.mode !== "disabled").length
              : 0;
            const displayName =
              catalog.find((entry) => entry.id === server.catalogId)?.name ?? server.name;
            return (
              <Card key={server.name} data-testid={`mcp-card-${server.name}`}>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="break-words"><span data-i18n-ignore>{displayName}</span></CardTitle>
                      {server.description ? <CardDescription className="break-words" data-i18n-ignore>{server.description}</CardDescription> : null}
                    </div>
                    <Badge data-testid={`mcp-status-${server.name}`} variant={status.variant}>
                      {status.label}
                    </Badge>
                  </div>
                  {status.failed ? (
                    <p
                      className="mt-1 break-all text-xs text-muted-foreground"
                      data-testid={`mcp-failure-${server.name}`}
                    >
                      {probe?.reason ? (
                        <span data-i18n-ignore>{probe.reason}</span>
                      ) : (
                        t("mcp.unknownReason")
                      )}
                    </p>
                  ) : null}
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mr-auto"
                      aria-expanded={expanded.includes(server.name)}
                      onClick={() => toggleExpanded(server.name)}
                    >
                      {tools.length > 0
                        ? t("mcp.toolsCount", { enabled: enabledCount, total: tools.length })
                        : t("mcp.tools")}
                    </Button>
                    {needsAuth ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!ready || busy === server.name}
                        onClick={() => void relogin(server.name)}
                      >
                        {t("mcp.relogin")}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={t("mcp.toggleAria", {
                        action: enabled ? t("mcp.toggleDisable") : t("mcp.toggleEnable"),
                        name: server.name,
                      })}
                      disabled={!ready || busy === server.name}
                      onClick={() => void toggleServer(server)}
                    >
                      {enabled ? t("mcp.toggleDisable") : t("mcp.toggleEnable")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!ready || busy === server.name}
                      onClick={() => void removeServer(server)}
                    >
                      <Trash2 aria-hidden />
                      {t("mcp.remove")}
                    </Button>
                  </div>
                  <details className="mt-3 min-w-0 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">{t("common.details")}</summary>
                    <p className="mt-2 break-all" data-i18n-ignore>{server.url}</p>
                  </details>
                  {expanded.includes(server.name) ? (
                    <div className="mt-3 border-t border-border pt-3">
                      <McpToolList
                        tools={tools}
                        reviewable={reviewable}
                        dirty={dirtyServers.some((entry) => entry.name === server.name)}
                        saving={savingTools === server.name}
                        disabled={!ready}
                        onChange={(toolName, mode) =>
                          changeTool(server.name, toolName, mode)
                        }
                        onSave={() => void saveTools(server)}
                      />
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <Button type="button" variant="outline" onClick={() => void reload()}>
          <RefreshCw aria-hidden />
          {t("mcp.reload")}
        </Button>
      </div>

      <McpAddDialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setAddError(null);
        }}
        catalog={catalog}
        existingNames={servers.map((server) => server.name)}
        onAdd={addServer}
        error={addError}
      />
    </div>
  );
}
