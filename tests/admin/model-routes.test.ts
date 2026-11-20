import { describe, expect, it } from "vitest";
import {
  createModelAuthRoutes,
  MODEL_AUTH_PREFIX,
  type ModelAuthDeps,
} from "../../src/admin/model-routes";

type Recorded = {
  started: number;
  polled: { deviceAuthId: string; userCode: string }[];
  browserStarted: number;
  browserCompleted: { code: string; codeVerifier: string; state: string }[];
  disconnected: number;
};

function harness(
  overrides: Partial<ModelAuthDeps> = {},
): { routes: ReturnType<typeof createModelAuthRoutes>; calls: Recorded } {
  const calls: Recorded = {
    started: 0,
    polled: [],
    browserStarted: 0,
    browserCompleted: [],
    disconnected: 0,
  };
  const deps: ModelAuthDeps = {
    status: async () => [{ id: "openai-codex", connected: false }],
    start: async () => {
      calls.started += 1;
      return {
        deviceAuthId: "device-1",
        userCode: "ABCD-1234",
        verificationUrl: "https://auth.openai.com/codex/device",
        intervalSeconds: 5,
      };
    },
    poll: async (device) => {
      calls.polled.push(device);
      return { status: "pending" };
    },
    startBrowser: async () => {
      calls.browserStarted += 1;
      return {
        authorizeUrl: "https://auth.openai.com/oauth/authorize?state=probe",
        state: "0123456789abcdef0123456789abcdef",
        codeVerifier: "verifier-1",
      };
    },
    completeBrowser: async (input) => {
      calls.browserCompleted.push(input);
    },
    disconnect: async () => {
      calls.disconnected += 1;
    },
    ...overrides,
  };
  return { routes: createModelAuthRoutes(deps), calls };
}

function call(
  routes: ReturnType<typeof createModelAuthRoutes>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return routes.fetch(
    new Request(`https://example.com${MODEL_AUTH_PREFIX}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe("model auth routes", () => {
  it("lists the subscription providers", async () => {
    const { routes } = harness();
    const response = await call(routes, "GET", "");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providers: [{ id: "openai-codex", connected: false }],
    });
  });

  it("starts a login and returns the device code", async () => {
    const { routes, calls } = harness();
    const response = await call(routes, "POST", "/openai-codex/start");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deviceAuthId: "device-1",
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
      intervalSeconds: 5,
    });
    expect(calls.started).toBe(1);
  });

  it("forwards the device pair on poll", async () => {
    const { routes, calls } = harness();
    const response = await call(routes, "POST", "/openai-codex/poll", {
      deviceAuthId: "device-1",
      userCode: "ABCD-1234",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "pending" });
    expect(calls.polled).toEqual([{ deviceAuthId: "device-1", userCode: "ABCD-1234" }]);
  });

  it("rejects a poll without the device pair", async () => {
    const { routes, calls } = harness();
    const response = await call(routes, "POST", "/openai-codex/poll", {
      deviceAuthId: "device-1",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "MODEL_AUTH_INVALID" });
    expect(calls.polled).toEqual([]);
  });

  it("refuses providers that are not subscriptions", async () => {
    const { routes, calls } = harness();
    const response = await call(routes, "POST", "/deepseek/start");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "MODEL_AUTH_UNKNOWN_PROVIDER" });
    expect(calls.started).toBe(0);
  });

  it("hides the upstream failure text", async () => {
    const { routes } = harness({
      start: async () => {
        throw new Error("token=secret-value");
      },
    });
    const response = await call(routes, "POST", "/openai-codex/start");

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret-value");
  });

  it("starts the browser flow", async () => {
    const { routes, calls } = harness();
    const response = await call(routes, "POST", "/openai-codex/browser/start");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizeUrl: string; codeVerifier: string };
    expect(body.authorizeUrl).toContain("auth.openai.com/oauth/authorize");
    expect(body.codeVerifier).toBe("verifier-1");
    expect(calls.browserStarted).toBe(1);
  });

  it("completes the browser flow and hides upstream text", async () => {
    const { routes, calls } = harness();
    const response = await call(routes, "POST", "/openai-codex/browser/complete", {
      code: "code-1",
      codeVerifier: "verifier-1",
      state: "0123456789abcdef0123456789abcdef",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "done" });
    expect(calls.browserCompleted).toEqual([
      {
        code: "code-1",
        codeVerifier: "verifier-1",
        state: "0123456789abcdef0123456789abcdef",
      },
    ]);
  });

  it("rejects an incomplete browser completion", async () => {
    const { routes, calls } = harness();
    const response = await call(routes, "POST", "/openai-codex/browser/complete", {
      code: "code-1",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "MODEL_AUTH_INVALID" });
    expect(calls.browserCompleted).toEqual([]);
  });

  it("hides a failed browser exchange", async () => {
    const { routes } = harness({
      completeBrowser: async () => {
        throw new Error("token=secret-value");
      },
    });
    const response = await call(routes, "POST", "/openai-codex/browser/complete", {
      code: "code-1",
      codeVerifier: "verifier-1",
      state: "0123456789abcdef0123456789abcdef",
    });

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret-value");
  });

  it("disconnects", async () => {
    const { routes, calls } = harness();
    const response = await call(routes, "DELETE", "/openai-codex");

    expect(response.status).toBe(204);
    expect(calls.disconnected).toBe(1);
  });

  it("answers 404 for an unknown action", async () => {
    const { routes } = harness();
    const response = await call(routes, "POST", "/openai-codex/refresh");

    expect(response.status).toBe(404);
  });
});
