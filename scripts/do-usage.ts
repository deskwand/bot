/**
 * Reports Durable Objects SQLite row usage from the Cloudflare GraphQL API.
 *
 * Usage:
 *   npm run do-usage                                  # last 3 days per class
 *   npm run do-usage -- --objects TaskDO --date 2026-11-05
 *
 * Reuses the OAuth token that `wrangler login` already stored. The account id
 * comes from CLOUDFLARE_ACCOUNT_ID or the first 32-hex id printed by
 * `wrangler whoami`, which runs first so it can refresh an expired token.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, readOAuthToken, summarize, type UsageRow } from "./lib/do-usage.ts";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }> | null;
};

type Groups = {
  viewer: {
    accounts: Array<{
      durableObjectsPeriodicGroups: Array<{
        dimensions: { date?: string; namespaceId?: string; objectId?: string };
        sum: { rowsWritten?: number; rowsRead?: number; activeTime?: number };
      }>;
    }>;
  };
};

function loadOAuthToken(): string | null {
  const candidates = [
    join(homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml"),
    join(homedir(), ".wrangler", "config", "default.toml"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const token = readOAuthToken(readFileSync(path, "utf8"));
    if (token) return token;
  }
  return null;
}

function resolveAccountId(): string | null {
  // Always run whoami, even with CLOUDFLARE_ACCOUNT_ID set: it refreshes an
  // expired OAuth token before loadOAuthToken reads it.
  let fromWhoami: string | null = null;
  try {
    const output = execFileSync("npx", ["wrangler", "whoami"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    fromWhoami = /[0-9a-f]{32}/i.exec(output)?.[0] ?? null;
  } catch {
    // Fall through to the environment variable.
  }
  return process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || fromWhoami;
}

async function graphql<T>(token: string, query: string): Promise<T> {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw new Error(`GraphQL 请求失败：HTTP ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    throw new Error(`GraphQL 查询失败：${body.errors.map((error) => error.message).join("; ")}`);
  }
  if (!body.data) throw new Error("GraphQL 查询没有返回数据。");
  return body.data;
}

async function fetchClasses(token: string, accountId: string): Promise<Record<string, string>> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`读取 DO 命名空间失败：HTTP ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as {
    result?: Array<{ id?: string; class?: string }>;
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(`读取 DO 命名空间失败：${body.errors.map((error) => error.message).join("; ")}`);
  }
  const classes: Record<string, string> = {};
  for (const namespace of body.result ?? []) {
    if (namespace.id && namespace.class) classes[namespace.id] = namespace.class;
  }
  return classes;
}

function utcDate(daysAgo: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

async function printDailyUsage(
  token: string,
  accountId: string,
  classes: Record<string, string>,
  days: number,
): Promise<void> {
  const from = utcDate(days - 1);
  const query = `query {
    viewer {
      accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
        durableObjectsPeriodicGroups(
          filter: { date_geq: ${JSON.stringify(from)} }
          limit: 1000
          orderBy: [date_DESC]
        ) {
          dimensions { date namespaceId }
          sum { rowsWritten rowsRead activeTime }
        }
      }
    }
  }`;
  const data = await graphql<Groups>(token, query);
  const groups = data.viewer.accounts[0]?.durableObjectsPeriodicGroups ?? [];
  const rows: UsageRow[] = groups.map((group) => ({
    date: group.dimensions.date ?? "",
    namespaceId: group.dimensions.namespaceId ?? "",
    rowsWritten: group.sum.rowsWritten ?? 0,
    rowsRead: group.sum.rowsRead ?? 0,
    activeTime: group.sum.activeTime ?? 0,
  }));

  const table: Array<Record<string, string | number>> = [];
  for (const day of summarize(rows, classes)) {
    for (const row of day.byClass) {
      table.push({
        日期: day.date,
        类: row.className,
        rowsWritten: row.rowsWritten,
        rowsRead: row.rowsRead,
        activeTime: row.activeTime,
        占额度: "",
      });
    }
    table.push({
      日期: day.date,
      类: "合计",
      rowsWritten: day.totalWritten,
      rowsRead: day.byClass.reduce((sum, row) => sum + row.rowsRead, 0),
      activeTime: day.byClass.reduce((sum, row) => sum + row.activeTime, 0),
      占额度: `${day.pctOfFree.toFixed(2)}%`,
    });
  }
  console.table(table);
}

async function printObjectUsage(
  token: string,
  accountId: string,
  classes: Record<string, string>,
  className: string,
  date: string,
): Promise<void> {
  const namespaceId = Object.keys(classes).find((id) => classes[id] === className);
  if (!namespaceId) {
    throw new Error(`找不到类 ${className} 对应的 DO 命名空间。`);
  }
  const query = `query {
    viewer {
      accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
        durableObjectsPeriodicGroups(
          filter: { date: ${JSON.stringify(date)}, namespaceId: ${JSON.stringify(namespaceId)} }
          limit: 20
          orderBy: [sum_rowsWritten_DESC]
        ) {
          dimensions { objectId }
          sum { rowsWritten rowsRead activeTime }
        }
      }
    }
  }`;
  const data = await graphql<Groups>(token, query);
  const groups = data.viewer.accounts[0]?.durableObjectsPeriodicGroups ?? [];
  console.table(
    groups.map((group) => ({
      objectId: group.dimensions.objectId ?? "",
      rowsWritten: group.sum.rowsWritten ?? 0,
      rowsRead: group.sum.rowsRead ?? 0,
      activeTime: group.sum.activeTime ?? 0,
    })),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const accountId = resolveAccountId();
  if (!accountId) {
    console.error("无法确定 Cloudflare 账号 ID，请设置 CLOUDFLARE_ACCOUNT_ID 或运行 npx wrangler whoami。");
    process.exit(1);
  }
  const token = loadOAuthToken();
  if (!token) {
    console.error("找不到 wrangler 的 OAuth token，请先运行 npx wrangler login。");
    process.exit(1);
  }

  const classes = await fetchClasses(token, accountId);
  if (args.objects) {
    await printObjectUsage(token, accountId, classes, args.objects.className, args.objects.date);
  } else {
    await printDailyUsage(token, accountId, classes, args.days);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
