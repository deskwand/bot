import { describe, expect, it } from "vitest";
import {
  createOwnerRoutes,
  OWNER_OPEN_PATH,
  OWNER_REVOKE_PATH,
  OWNER_STATUS_PATH,
  type OwnerStatus,
} from "../../src/admin/owner-routes";

const claimed: OwnerStatus = {
  mode: "claimed",
  ownerUserId: "111",
  windowOpenedAt: 1,
  windowClosesAt: 2,
};

describe("/admin/owner", () => {
  it("GET status 返回状态对象", async () => {
    const reads = {
      status: async () => claimed,
      open: async () => claimed,
      revoke: async () => claimed,
    };
    const response = await createOwnerRoutes(reads).fetch(
      new Request("https://bot.test" + OWNER_STATUS_PATH),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(claimed);
  });

  it("POST open 与 POST revoke 各自调对应读取函数", async () => {
    const calls: string[] = [];
    const reads = {
      status: async () => claimed,
      open: async () => {
        calls.push("open");
        return { ...claimed, mode: "claimable" as const };
      },
      revoke: async () => {
        calls.push("revoke");
        return { ...claimed, mode: "closed" as const, ownerUserId: null };
      },
    };
    const routes = createOwnerRoutes(reads);
    expect(
      await (
        await routes.fetch(
          new Request("https://bot.test" + OWNER_OPEN_PATH, { method: "POST" }),
        )
      ).json(),
    ).toMatchObject({ mode: "claimable" });
    expect(
      await (
        await routes.fetch(
          new Request("https://bot.test" + OWNER_REVOKE_PATH, {
            method: "POST",
          }),
        )
      ).json(),
    ).toMatchObject({ mode: "closed" });
    expect(calls).toEqual(["open", "revoke"]);
  });

  it("方法不对给 405，路径不对给 404", async () => {
    const reads = {
      status: async () => claimed,
      open: async () => claimed,
      revoke: async () => claimed,
    };
    const routes = createOwnerRoutes(reads);
    expect(
      (
        await routes.fetch(
          new Request("https://bot.test" + OWNER_STATUS_PATH, {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(405);
    expect(
      (await routes.fetch(new Request("https://bot.test/admin/owner/nope")))
        .status,
    ).toBe(404);
  });

  it("DO 抛错时给 503 与固定 code", async () => {
    const reads = {
      status: async (): Promise<OwnerStatus> => {
        throw new Error("boom");
      },
      open: async () => claimed,
      revoke: async () => claimed,
    };
    const response = await createOwnerRoutes(reads).fetch(
      new Request("https://bot.test" + OWNER_STATUS_PATH),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "OWNER_STATUS_FAILED" });
  });
});
