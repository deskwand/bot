import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../src/gateway";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

type WebhookOutcome = "accepted" | "maintenance";

function setup(
  handleTelegramWebhook: (req: Request) => Promise<WebhookOutcome> = async () =>
    "accepted",
) {
  const gateway = createGateway({
    channels: () => ({ handleTelegramWebhook }),
    artifacts: env.ARTIFACTS,
  });
  return { gateway };
}

function webhook(): Request {
  return new Request("https://example.com/telegram/webhook", {
    method: "POST",
  });
}

describe("POST /telegram/webhook", () => {
  it("returns 200 when forwarding to the channel hub throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = setup(async () => {
      throw new Error("channel hub down");
    });

    const response = await h.gateway.fetch(webhook());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("returns 503 when the channel hub is in maintenance", async () => {
    const h = setup(async () => "maintenance");

    const response = await h.gateway.fetch(webhook());

    expect(response.status).toBe(503);
  });
});

describe("GET /a/<key>", () => {
  it("returns 404 for a missing artifact", async () => {
    const h = setup();

    const response = await h.gateway.fetch(
      new Request("https://example.com/a/missing"),
    );

    expect(response.status).toBe(404);
  });

  it("serves an allowlisted artifact inline with hardening headers", async () => {
    await env.ARTIFACTS.put("t1/u/r.md", "hi", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    const h = setup();

    const response = await h.gateway.fetch(
      new Request("https://example.com/a/t1/u/r.md"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hi");
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("content-disposition")).toBeNull();
  });

  it.each(["text/html", "image/svg+xml"])(
    "forces a %s artifact to download as octet-stream",
    async (contentType) => {
      const key = `t1/u/${contentType.replace("/", "-")}`;
      await env.ARTIFACTS.put(key, "<script>alert(1)</script>", {
        httpMetadata: { contentType },
      });
      const h = setup();

      const response = await h.gateway.fetch(
        new Request(`https://example.com/a/${key}`),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
    },
  );
});

describe("worker entry", () => {
  it("returns 404 for unknown paths", async () => {
    const response = await SELF.fetch("https://example.com/unknown");

    expect(response.status).toBe(404);
  });

  it("serves artifacts while DESKWAND_CONFIG is missing", async () => {
    const runtime = env as unknown as Record<string, unknown>;
    const saved = runtime.DESKWAND_CONFIG;
    delete runtime.DESKWAND_CONFIG;

    try {
      await env.ARTIFACTS.put("cfg/missing/r.md", "still served", {
        httpMetadata: { contentType: "text/markdown" },
      });
      const response = await SELF.fetch(
        "https://example.com/a/cfg/missing/r.md",
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("still served");
    } finally {
      runtime.DESKWAND_CONFIG = saved;
    }
  });
});
