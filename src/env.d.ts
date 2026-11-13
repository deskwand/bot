// Secrets are provided with `wrangler secret put` (and `.dev.vars` locally),
// so `wrangler types` cannot infer them. Merge them into the generated `Env`.
declare namespace Cloudflare {
  interface Env {
    [key: `MODEL_KEY_${string}`]: string | undefined;
    [key: `EXCHANGE_SECRET_${string}`]: string | undefined;
    TELEGRAM_BOT_TOKEN?: string;
    WALLET_PRIVATE_KEY?: string;
    WALLET_OWNER_ADDRESS?: string;
    WECHAT_CREDENTIALS?: string;
    /** Bearer token guarding `/admin/*`; unset disables the routes. */
    ADMIN_TOKEN?: string;
    /** Deployable non-secret configuration; see contracts/deployment-config.schema.json. */
    DESKWAND_CONFIG?: unknown;
    /** Selected business channel; absent keeps the Telegram default. */
    ACTIVE_CHANNEL?: string;
    /** Sandbox executor base URL, e.g. http://sandbox:8080 (container deployments). */
    SANDBOX_URL?: string;
    /** Shared bearer token for the sandbox executor. */
    SANDBOX_TOKEN?: string;
    /** Local artifact store (container deployments only); absent on Cloudflare. */
    ARTIFACT_STORE?: DurableObjectNamespace<
      import("../container/store/store-do").StoreDO
    >;
  }
}

interface Env extends Cloudflare.Env {}
