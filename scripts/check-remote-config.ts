/**
 * Refuses a CLI deploy that would overwrite the Worker configuration client
 * state. Cloudflare keeps the remote DESKWAND_CONFIG binding, but a deploy of
 * a template that does not declare it is only safe when the remote value is
 * already present.
 *
 * Usage:
 *   npm run predeploy             # invoked automatically by `npm run deploy`
 *   npm run predeploy -- --force  # bypass the check intentionally
 *
 * Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment.
 * If either is absent, or the Worker does not exist yet, it warns and skips.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_BINDING = "DESKWAND_CONFIG";

export type PredeployDecision =
  | { action: "allow"; message?: string }
  | { action: "skip"; message: string }
  | { action: "refuse"; message: string };

export type PredeployInput = {
  force: boolean;
  hasToken: boolean;
  hasAccount: boolean;
  workerExists: boolean;
  hasConfigBinding: boolean;
};

/** Pure decision logic, unit-tested in tests-node/predeploy.test.ts. */
export function decidePredeploy(input: PredeployInput): PredeployDecision {
  if (!input.hasToken || !input.hasAccount) {
    return {
      action: "skip",
      message: "缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID，跳过远端 DESKWAND_CONFIG 检查。",
    };
  }
  if (!input.workerExists) {
    return {
      action: "skip",
      message: "远端 Worker 尚不存在，跳过 DESKWAND_CONFIG 检查。",
    };
  }
  if (input.hasConfigBinding) {
    return { action: "allow", message: "远端 Worker 已存在 DESKWAND_CONFIG binding。" };
  }
  if (input.force) {
    return {
      action: "allow",
      message: "警告：远端 Worker 没有 DESKWAND_CONFIG binding，--force 允许继续。",
    };
  }
  return {
    action: "refuse",
    message:
      "拒绝部署：远端 Worker 已存在，但没有 DESKWAND_CONFIG binding。命令行部署可能覆盖客户端配置。请先在 Cloudflare 写入与当前服务一致的 DESKWAND_CONFIG，或使用 --force 明确跳过检查。",
  };
}

/** Extracts the top-level Worker name from wrangler.jsonc without a JSONC parser. */
export function workerNameFromConfig(text: string): string | undefined {
  const match = /"name"\s*:\s*"([^"]+)"/.exec(text);
  return match?.[1]?.trim() || undefined;
}

/** Reads bindings from either the raw settings object or its API envelope. */
export function settingsBindings(settings: unknown): unknown[] {
  if (!settings || typeof settings !== "object") return [];
  const root = settings as Record<string, unknown>;
  const result = root.result;
  const target =
    result && typeof result === "object" ? (result as Record<string, unknown>) : root;
  return Array.isArray(target.bindings) ? target.bindings : [];
}

export function hasConfigBinding(settings: unknown): boolean {
  return settingsBindings(settings).some((binding) => {
    if (!binding || typeof binding !== "object") return false;
    return (binding as Record<string, unknown>).name === CONFIG_BINDING;
  });
}

async function main(): Promise<void> {
  const force = process.argv.slice(2).includes("--force");
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  if (!token || !account) {
    console.warn(
      decidePredeploy({
        force,
        hasToken: false,
        hasAccount: false,
        workerExists: false,
        hasConfigBinding: false,
      }).message,
    );
    return;
  }

  const repoRoot = resolve(import.meta.dirname, "..");
  const workerName =
    process.env.DESKWAND_WORKER_NAME?.trim() ||
    workerNameFromConfig(readFileSync(resolve(repoRoot, "wrangler.jsonc"), "utf8"));
  if (!workerName) {
    console.warn("无法从 wrangler.jsonc 读取 Worker 名称，跳过 DESKWAND_CONFIG 检查。");
    return;
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(workerName)}/settings`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) {
    const decision = decidePredeploy({
      force,
      hasToken: true,
      hasAccount: true,
      workerExists: false,
      hasConfigBinding: false,
    });
    console.warn(decision.message);
    return;
  }
  if (!response.ok) {
    throw new Error(`读取 Worker settings 失败：HTTP ${response.status} ${response.statusText}`);
  }
  const settings: unknown = await response.json();
  const decision = decidePredeploy({
    force,
    hasToken: true,
    hasAccount: true,
    workerExists: true,
    hasConfigBinding: hasConfigBinding(settings),
  });
  if (decision.action === "refuse") {
    throw new Error(decision.message);
  }
  if (decision.action === "allow" && decision.message) {
    console.log(decision.message);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
