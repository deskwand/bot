import { expect, test, type Page } from "@playwright/test";
import { expectNoChinese, useEnglish } from "./i18n-helpers";

type Published = {
  baseFingerprint?: string;
  searchProvider?: string;
  secrets?: { name: string; operation: string; value?: string }[];
};

async function openSearch(page: Page, scenario = "configured") {
  await page.goto(`/test.html?fixture=${scenario}`);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "视野", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "视野", exact: true }),
  ).toBeVisible();
}

async function publishes(page: Page): Promise<Published[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __configCalls: { publish: Published[] };
        }
      ).__configCalls.publish,
  );
}

test("switches to tavily with a key", async ({ page }) => {
  await openSearch(page);

  await page.getByRole("radio", { name: "Tavily" }).check();
  await page.getByLabel("API 密钥").fill("tvly-test");
  await page.getByRole("button", { name: "保存并部署" }).click();

  await expect.poll(async () => (await publishes(page)).length).toBe(1);
  const call = (await publishes(page))[0];
  expect(call?.searchProvider).toBe("tavily");
  expect(call?.secrets).toEqual([
    { name: "SEARCH_KEY_TAVILY", operation: "replace", value: "tvly-test" },
  ]);
});

test("warns when the key is missing but still saves", async ({ page }) => {
  await openSearch(page);

  await page.getByRole("radio", { name: "Brave" }).check();
  await expect(page.getByText("未配置 key，将使用 Exa")).toBeVisible();
  await page.getByRole("button", { name: "保存并部署" }).click();

  await expect.poll(async () => (await publishes(page)).length).toBe(1);
  const call = (await publishes(page))[0];
  expect(call?.searchProvider).toBe("brave");
  expect(call?.secrets ?? []).toEqual([]);
});

test("deepseek shows the shared model key state", async ({ page }) => {
  await openSearch(page, "search-deepseek");

  await page.getByRole("radio", { name: "DeepSeek" }).check();
  await expect(page.getByText("MODEL_KEY_DEEPSEEK")).toBeVisible();
  await expect(page.getByText("已配置", { exact: true })).toBeVisible();
  await expect(page.getByText("未配置 key，将使用 Exa")).toHaveCount(0);
  await expect(page.getByLabel("API 密钥")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "清除已保存密钥" }),
  ).toHaveCount(0);
});

test("a key-only save omits searchProvider", async ({ page }) => {
  await openSearch(page, "search-tavily");

  await expect(page.getByRole("radio", { name: "Tavily" })).toBeChecked();
  await page.getByLabel("API 密钥").fill("tvly-key-only");
  await page.getByRole("button", { name: "保存并部署" }).click();

  await expect.poll(async () => (await publishes(page)).length).toBe(1);
  const call = (await publishes(page))[0];
  expect(call?.secrets).toEqual([
    { name: "SEARCH_KEY_TAVILY", operation: "replace", value: "tvly-key-only" },
  ]);
  expect(Object.hasOwn(call ?? {}, "searchProvider")).toBe(false);
});

test("defaults to exa", async ({ page }) => {
  await openSearch(page);

  await expect(page.getByRole("radio", { name: "Exa" })).toBeChecked();
});

test("english has no chinese", async ({ page }) => {
  await useEnglish(page, "/test.html?fixture=configured");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Sight", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sight", exact: true }),
  ).toBeVisible();

  await expectNoChinese(page);
});
