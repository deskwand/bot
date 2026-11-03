import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useApp } from "@/components/app-context";
import { ErrorAlert } from "@/components/feedback";
import { useDirty } from "@/components/use-dirty";
import { toClientError } from "@/services/errors";
import type {
  ConfigDTO,
  McpAddInput,
  McpCatalogEntryDTO,
  McpProbeDTO,
  McpToolDTO,
} from "@/services/types";
import { McpAddDialog } from "./McpAddDialog";
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
  const [catalog, setCatalog] = useState<McpCatalogEntryDTO[]>([]);
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [auth, setAuth] = useState<Record<string, string>>({});
  const [probes, setProbes] = useState<Record<string, McpProbeDTO>>({});
  const [drafts, setDrafts] = useState<Record<string, McpToolDTO[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [pendingAuth, setPendingAuth] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
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

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setAdminError(null);
    setError(null);
    try {
      const [config, nextCatalog] = await Promise.all([
        client.getConfig(),
        client.mcpCatalog(),
      ]);
      const list = parseServers((config as ConfigDTO).mcpServers);
      setServers(list);
      setCatalog(nextCatalog);
      await refresh(list);
    } catch (cause) {
      if (isAdminUnavailable(cause)) {
        setAdminError(cause);
      } else {
        setLoadError(cause);
      }
    } finally {
      setLoading(false);
    }
  }, [client, refresh]);

  useEffect(() => {
    void load();
  }, [load]);

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
      const config = await client.getConfig();
      const list = parseServers(config.mcpServers);
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

  const saveTools = async (server: McpServerConfig) => {
    const tools = drafts[server.name] ?? [];
    const next: McpServerConfig = {
      ...server,
      autoApprove: tools.filter((tool) => tool.mode === "auto").map((tool) => tool.name),
      requireApproval: tools
        .filter((tool) => tool.mode === "approval")
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
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="mb-2 text-xs tracking-[0.18em] text-muted-foreground">服务配置</p>
        <h1 className="text-2xl font-semibold tracking-tight">服务</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          接入远程 MCP 服务，任务执行时按工具审批设置调用。
        </p>
      </div>
      <Button type="button" onClick={() => setAddOpen(true)} disabled={loading || !catalog.length}>
        <Plus aria-hidden />
        添加服务
      </Button>
    </div>
  );

  if (loading) {
    return (
      <div>
        {header}
        <div className="flex min-h-[30svh] items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />
          正在读取服务…
        </div>
      </div>
    );
  }

  if (adminError) {
    return (
      <div>
        {header}
        <Alert variant="destructive" className="my-4" data-testid="mcp-admin-unavailable">
          <AlertTitle>云端管理接口不可用</AlertTitle>
          <AlertDescription>
            <span className="block">{toClientError(adminError).message}</span>
            <span className="mt-3 flex">
              <Button type="button" size="sm" onClick={() => void load()}>
                重试
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div>
      {header}

      <ErrorAlert error={loadError} onRetry={() => void load()} />
      <ErrorAlert error={error} />
      {enabledToolCount > TOOL_WARNING_THRESHOLD ? (
        <Alert className="my-4" data-testid="mcp-tool-warning">
          <AlertTitle>工具较多</AlertTitle>
          <AlertDescription>
            {`已启用 ${enabledToolCount} 个工具，过多会拖慢任务并增加费用，建议停用用不到的工具。`}
          </AlertDescription>
        </Alert>
      ) : null}

      {servers.length === 0 ? (
        <Card className="mt-5">
          <CardContent className="py-6 text-sm text-muted-foreground">
            还没有接入服务。从目录添加一个，或填写自定义 URL。
          </CardContent>
        </Card>
      ) : (
        <div className="mt-5 space-y-3">
          {servers.map((server) => {
            const probe = probes[server.name];
            const tools = drafts[server.name] ?? probe?.tools ?? [];
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
              ? "⏸ 已停用"
              : auth[server.name] === "needs_reauth"
                ? "🔑 需要重新授权"
                : auth[server.name] === "unauthorized"
                  ? "🔑 需要授权"
                  : probe && !probe.ok
                    ? `⚠️ 连接失败：${probe.reason || "未知原因"}`
                    : probe?.ok
                      ? "✅ 正常"
                      : "正在测试连接…";
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
                      <CardTitle>{displayName}</CardTitle>
                      <CardDescription className="break-all">
                        {server.description || server.url}
                      </CardDescription>
                    </div>
                    <span
                      data-testid={`mcp-status-${server.name}`}
                      className="text-sm font-medium"
                    >
                      {status}
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-auto text-xs text-muted-foreground">
                      已启用工具 {enabledCount} 个
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-expanded={expanded.includes(server.name)}
                      onClick={() => toggleExpanded(server.name)}
                    >
                      工具（{tools.length}）
                    </Button>
                    {needsAuth ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy === server.name}
                        onClick={() => void relogin(server.name)}
                      >
                        重新登录
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`${enabled ? "停用" : "启用"} ${server.name}`}
                      disabled={busy === server.name}
                      onClick={() => void toggleServer(server)}
                    >
                      {enabled ? "停用" : "启用"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy === server.name}
                      onClick={() => void removeServer(server)}
                    >
                      <Trash2 aria-hidden />
                      删除
                    </Button>
                  </div>
                  {expanded.includes(server.name) ? (
                    <div className="mt-3 border-t border-border pt-3">
                      <McpToolList
                        tools={tools}
                        dirty={dirtyServers.some((entry) => entry.name === server.name)}
                        saving={savingTools === server.name}
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
        <Button type="button" variant="outline" onClick={() => void load()}>
          <RefreshCw aria-hidden />
          重新加载
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
