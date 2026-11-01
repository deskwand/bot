import { pathToFileURL } from "node:url";
import { createILinkClient, credentialsFromQrStatus } from "../src/channels/wechat/ilink.ts";

type LoginClient = Pick<ReturnType<typeof createILinkClient>, "getBotQrCode" | "getQrStatus">;

export async function runLogin(deps: {
  client: LoginClient;
  renderQr(text: string): void;
  log(msg: string): void;
  putSecret(json: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const qr = await deps.client.getBotQrCode();
    deps.renderQr(qr.imageContent);
    deps.log(qr.imageContent);
    while (true) {
      await deps.sleep(2000);
      const result = await deps.client.getQrStatus(qr.qrcode);
      if (result.status === "expired") break;
      if (result.status === "scaned") {
        deps.log("已扫码，请在手机上确认");
      }
      if (result.status !== "confirmed") continue;
      const credentials = credentialsFromQrStatus(result.raw);
      if (!credentials) throw new Error("登录响应缺少凭据字段");
      await deps.putSecret(JSON.stringify(credentials));
      deps.log(`已登录：${credentials.userId}`);
      return credentials.userId;
    }
  }
  throw new Error("二维码已过期，请重新运行 npm run wechat-login");
}

async function main(): Promise<void> {
  const { default: qrcode } = await import("qrcode-terminal");
  const { spawn } = await import("node:child_process");
  await runLogin({
    client: createILinkClient({}),
    renderQr: (text) => qrcode.generate(text, { small: true }),
    log: (msg) => console.log(msg),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    putSecret: (json) => new Promise<void>((resolve, reject) => {
      const env = { ...process.env };
      for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
        delete env[key];
      }
      const child = spawn("npx", ["wrangler", "secret", "put", "WECHAT_CREDENTIALS"], {
        env,
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.on("error", () => reject(new Error("无法启动 wrangler")));
      child.stdin.on("error", () => reject(new Error("无法写入微信凭据")));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("写入 WECHAT_CREDENTIALS 失败"));
      });
      child.stdin.end(json);
    }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch(() => {
    // API errors can contain server-provided text. Keep credentials out of logs.
    console.error("微信登录失败，请检查网络和 Cloudflare 登录状态后重试。");
    process.exitCode = 1;
  });
}
