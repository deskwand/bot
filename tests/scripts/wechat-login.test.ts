import { describe, expect, it } from "vitest";
import { runLogin } from "../../scripts/wechat-login";

function harness(statuses: Array<{ status: "wait" | "scaned" | "confirmed" | "expired"; raw: Record<string, unknown> }>) {
  const logs: string[] = [];
  const codes: string[] = [];
  const secrets: string[] = [];
  const sleeps: number[] = [];
  let issued = 0;
  return {
    logs, codes, secrets, sleeps,
    deps: {
      client: {
        async getBotQrCode() {
          issued++;
          return { qrcode: `qr-${issued}`, imageContent: `https://example.com/qr-${issued}` };
        },
        async getQrStatus(qrcode: string) {
          expect(qrcode).toBe(`qr-${issued}`);
          const next = statuses.shift();
          if (!next) throw new Error("unexpected status request");
          return next;
        },
      },
      renderQr(text: string) { codes.push(text); },
      log(text: string) { logs.push(text); },
      async putSecret(json: string) { secrets.push(json); },
      async sleep(ms: number) { sleeps.push(ms); },
    },
  };
}

describe("WeChat login", () => {
  it("waits for confirmation then uploads credentials without logging the token", async () => {
    const h = harness([
      { status: "wait", raw: { status: "wait" } },
      { status: "scaned", raw: { status: "scaned" } },
      { status: "confirmed", raw: {
        status: "confirmed", bot_token: "secret-test-token", baseurl: "https://example.com",
        ilink_bot_id: "account-1", ilink_user_id: "owner-1",
      } },
    ]);
    expect(await runLogin(h.deps)).toBe("owner-1");
    expect(h.secrets.map((json) => JSON.parse(json))).toEqual([{
      token: "secret-test-token", baseUrl: "https://example.com", accountId: "account-1", userId: "owner-1",
    }]);
    expect(h.codes).toEqual(["https://example.com/qr-1"]);
    expect(h.logs).toContain("https://example.com/qr-1");
    expect(h.logs).toContain("已扫码，请在手机上确认");
    expect(h.logs).toContain("已登录：owner-1");
    expect(h.logs.join("\n")).not.toContain("secret-test-token");
    expect(h.sleeps).toEqual([2000, 2000, 2000]);
  });

  it("stops after three expired QR codes without uploading a secret", async () => {
    const h = harness(Array.from({ length: 3 }, () => ({ status: "expired" as const, raw: { status: "expired" } })));
    await expect(runLogin(h.deps)).rejects.toThrow("二维码已过期");
    expect(h.codes).toHaveLength(3);
    expect(h.secrets).toEqual([]);
  });

  it("rejects incomplete confirmed credentials without uploading", async () => {
    const h = harness([{ status: "confirmed", raw: { status: "confirmed", bot_token: "secret-test-token" } }]);
    await expect(runLogin(h.deps)).rejects.toThrow("登录响应缺少凭据字段");
    expect(h.secrets).toEqual([]);
    expect(h.logs.join("\n")).not.toContain("secret-test-token");
  });

  it("does not announce success when uploading the secret fails", async () => {
    const h = harness([{ status: "confirmed", raw: {
      bot_token: "secret-test-token", baseurl: "https://example.com",
      ilink_bot_id: "account-1", ilink_user_id: "owner-1",
    } }]);
    h.deps.putSecret = async () => { throw new Error("upload failed"); };
    await expect(runLogin(h.deps)).rejects.toThrow("upload failed");
    expect(h.logs.join("\n")).not.toContain("已登录");
  });
});
