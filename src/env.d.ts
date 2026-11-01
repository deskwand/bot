// Secrets are provided with `wrangler secret put` (and `.dev.vars` locally),
// so `wrangler types` cannot infer them. Merge them into the generated `Env`.
declare namespace Cloudflare {
  interface Env {
    OPENCODE_API_KEY: string;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_WEBHOOK_SECRET: string;
  }
}

interface Env extends Cloudflare.Env {}
