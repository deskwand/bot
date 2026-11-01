// Secrets are provided with `wrangler secret put` (and `.dev.vars` locally),
// so `wrangler types` cannot infer them. Merge them into the generated `Env`.
declare namespace Cloudflare {
  interface Env {
    OPENCODE_API_KEY?: string;
    ANTHROPIC_API_KEY?: string;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_WEBHOOK_SECRET?: string;
    WECHAT_CREDENTIALS?: string;
    /** Deployable non-secret configuration; see contracts/deployment-config.schema.json. */
    DESKWAND_CONFIG?: unknown;
    /** Selected business channel; absent keeps the Telegram default. */
    ACTIVE_CHANNEL?: string;
  }
}

interface Env extends Cloudflare.Env {}
