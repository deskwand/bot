/**
 * Registers the Telegram webhook for this Worker.
 *
 * Usage:
 *   npm run set-webhook -- https://<worker-domain>
 *
 * Falls back to PUBLIC_BASE_URL when the argument is omitted. Reads
 * TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from the environment, then
 * from `.dev.vars` (environment wins). Secrets are never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Vars = Record<string, string>;

/** Minimal KEY=VALUE parser for `.dev.vars` / dotenv-style files. */
export function parseVars(source: string): Vars {
  const vars: Vars = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) vars[key] = value;
  }
  return vars;
}

function loadDevVars(): Vars {
  const path = resolve(process.cwd(), ".dev.vars");
  if (!existsSync(path)) return {};
  return parseVars(readFileSync(path, "utf8"));
}

function readSetting(name: string, devVars: Vars): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  const fromFile = devVars[name];
  if (fromFile && fromFile.trim() !== "") return fromFile.trim();
  return undefined;
}

function webhookUrl(publicUrl: string): string {
  if (!/^https:\/\//i.test(publicUrl)) {
    fail(`publicUrl 必须以 https:// 开头（Telegram 要求 HTTPS）：${publicUrl}`);
  }
  return `${publicUrl.replace(/\/+$/, "")}/telegram/webhook`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const devVars = loadDevVars();
  const argUrl = process.argv[2]?.trim();

  const publicUrl =
    argUrl ||
    readSetting("PUBLIC_BASE_URL", devVars) ||
    fail("用法：npm run set-webhook -- <publicUrl>（或设置 PUBLIC_BASE_URL）");
  const token = readSetting("TELEGRAM_BOT_TOKEN", devVars);
  const secret = readSetting("TELEGRAM_WEBHOOK_SECRET", devVars);

  if (!token) {
    fail("缺少 TELEGRAM_BOT_TOKEN（环境变量或 .dev.vars）");
  }
  if (!secret) {
    fail("缺少 TELEGRAM_WEBHOOK_SECRET（环境变量或 .dev.vars）");
  }

  const url = webhookUrl(publicUrl);
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
      }),
    });
  } catch (error) {
    fail(
      `无法连接 Telegram API：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
  } | null;

  if (!response.ok || !body?.ok) {
    fail(
      `设置 webhook 失败（HTTP ${response.status}）：${
        body?.description ?? "无响应内容"
      }`,
    );
  }

  console.log(`Webhook 已设置：${url}`);
  console.log(`allowed_updates: message, callback_query`);
  if (body.description) console.log(body.description);
}

// Only run when executed directly, so the parser stays importable in tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
