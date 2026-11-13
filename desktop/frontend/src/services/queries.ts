import { useCallback, useMemo } from "react";
import {
  QueryCache,
  QueryClient,
  useQuery,
  useQueryClient,
  type QueryObserverResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useApp } from "@/components/app-context";
import { toClientError } from "@/services/errors";
import type {
  ClientService,
  ConfigDTO,
  ContainerStatusDTO,
  LifeVitalsDTO,
  StatusItemDTO,
} from "@/services/types";

export const queryKeys = {
  config: ["config"],
  status: ["status"],
  cachedConfig: ["cachedConfig"],
  cachedStatus: ["cachedStatus"],
  modelCatalog: ["modelCatalog"],
  mcpCatalog: ["mcpCatalog"],
  mcpStatus: ["mcpStatus"],
  exchangeSyncStatus: ["exchangeSyncStatus"],
  lifeVitals: ["lifeVitals"],
  walletStatus: ["walletStatus"],
  containerStatus: ["containerStatus"],
} as const;

function isAuthLost(error: unknown): boolean {
  const code = toClientError(error).code;
  return code === "AUTH_REAUTH_REQUIRED" || code === "AUTH_REQUIRED";
}

export function createAppQueryClient(onAuthLost: () => void): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 1_800_000,
        retry: (count, error) => !isAuthLost(error) && count < 1,
        refetchOnWindowFocus: false,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        if (isAuthLost(error)) onAuthLost();
      },
    }),
  });
}

export interface CachedQuery<T> {
  data: T | undefined;
  isPlaceholder: boolean;
  savedAt: string | null;
  isFetching: boolean;
  error: unknown;
  refetch: () => Promise<QueryObserverResult<T>>;
}

export function useConfigQuery(): CachedQuery<ConfigDTO> {
  const { client } = useApp();
  const cached = useQuery({
    queryKey: queryKeys.cachedConfig,
    queryFn: () => client.cachedConfig(),
    staleTime: Infinity,
  });
  const query = useQuery({
    queryKey: queryKeys.config,
    queryFn: () => client.getConfig(),
    placeholderData: cached.data?.data ?? undefined,
  });
  const cachedData = cached.data?.data;
  // A later refetch error keeps the query's previous data; only a first-fetch
  // error leaves it undefined. Fall back to the disk snapshot so the page can
  // report the failure without blanking.
  const data = query.data ?? (cachedData === null ? undefined : cachedData);
  const isPlaceholder =
    query.isPlaceholderData || (query.data === undefined && cachedData != null);
  return {
    data,
    isPlaceholder,
    savedAt: isPlaceholder ? (cached.data?.savedAt ?? null) : null,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useStatusQuery(): CachedQuery<StatusItemDTO[]> {
  const { client } = useApp();
  const cached = useQuery({
    queryKey: queryKeys.cachedStatus,
    queryFn: () => client.cachedStatus(),
    staleTime: Infinity,
  });
  const query = useQuery({
    queryKey: queryKeys.status,
    queryFn: () => client.status(),
    placeholderData: cached.data?.data ?? undefined,
  });
  const cachedData = cached.data?.data;
  const data = query.data ?? (cachedData === null ? undefined : cachedData);
  const isPlaceholder =
    query.isPlaceholderData || (query.data === undefined && cachedData != null);
  return {
    data,
    isPlaceholder,
    savedAt: isPlaceholder ? (cached.data?.savedAt ?? null) : null,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useModelCatalogQuery() {
  const { client } = useApp();
  return useQuery({
    queryKey: queryKeys.modelCatalog,
    queryFn: () => client.modelCatalog(),
    staleTime: 600_000,
  });
}

export function useMcpCatalogQuery() {
  const { client } = useApp();
  return useQuery({
    queryKey: queryKeys.mcpCatalog,
    queryFn: () => client.mcpCatalog(),
    staleTime: 600_000,
  });
}

export function useMcpStatusQuery(): UseQueryResult<Awaited<ReturnType<ClientService["mcpStatus"]>>> {
  const { client } = useApp();
  return useQuery({
    queryKey: queryKeys.mcpStatus,
    queryFn: () => client.mcpStatus(),
  });
}

export function useLifeVitalsQuery(enabled = true): UseQueryResult<LifeVitalsDTO> {
  const { client } = useApp();
  return useQuery({
    queryKey: queryKeys.lifeVitals,
    queryFn: () => client.lifeVitals(),
    enabled,
    retry: false,
  });
}

export function useContainerStatusQuery(
  enabled = true,
): UseQueryResult<ContainerStatusDTO> {
  const { client } = useApp();
  return useQuery({
    queryKey: queryKeys.containerStatus,
    queryFn: () => client.containerStatus(),
    enabled,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useInvalidate(): {
  config: () => void;
  configAndStatus: () => void;
  mcp: () => void;
} {
  const queryClient = useQueryClient();
  const config = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.config });
  }, [queryClient]);
  const configAndStatus = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.config });
    void queryClient.invalidateQueries({ queryKey: queryKeys.status });
  }, [queryClient]);
  const mcp = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.config });
    void queryClient.invalidateQueries({ queryKey: queryKeys.mcpStatus });
  }, [queryClient]);
  return useMemo(
    () => ({ config, configAndStatus, mcp }),
    [config, configAndStatus, mcp],
  );
}
