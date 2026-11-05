import { expect, test, type Page } from "@playwright/test";

async function openServices(page: Page, scenario = "configured") {
  await page.goto(`/test.html?fixture=${scenario}`);
  await page.getByRole("button", { name: "服务", exact: true }).click();
  await expect(page.getByRole("heading", { name: "服务", exact: true })).toBeVisible();
}

async function addCatalogEntry(page: Page, name: string) {
  await page.getByRole("button", { name: "添加服务" }).click();
  const catalog = page.getByRole("dialog", { name: "添加服务" });
  await expect(catalog).toBeVisible();
  await catalog.getByRole("button", { name: `添加 ${name}` }).click();
  const form = page.getByRole("dialog", { name: `添加 ${name}` });
  await expect(form).toBeVisible();
  return form;
}

async function mcpCalls(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __mcpCalls: {
            update: { name: string; server: Record<string, unknown>; secrets: unknown[] }[];
            remove: string[];
            start: string[];
          };
        }
      ).__mcpCalls,
  );
}

test("a catalog service can be added and shows a healthy card", async ({ page }) => {
  await openServices(page);
  const form = await addCatalogEntry(page, "DeepWiki");
  await form.getByRole("button", { name: "保存", exact: true }).click();

  const card = page.getByTestId("mcp-card-deepwiki");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("mcp-status-deepwiki")).toHaveText("正常");
  // 一个数字对：已启用 / 总数。分母必须非零——探针正常时不可能出现 工具 0/0。
  await expect(card.getByRole("button", { name: /^工具/ })).toHaveText(/^工具 \d+\/[1-9]\d*$/);
});

test("an empty required field keeps the save button disabled", async ({ page }) => {
  await openServices(page);
  const form = await addCatalogEntry(page, "GitHub");
  const save = form.getByRole("button", { name: "保存", exact: true });
  await expect(save).toBeDisabled();

  await form.getByLabel("Personal Access Token").fill("ghp_mcp_token");
  await expect(save).toBeEnabled();
});

test("an OAuth service starts authorization and becomes healthy when the status flips", async ({
  page,
}) => {
  await openServices(page);
  const form = await addCatalogEntry(page, "Notion");
  await form.getByRole("button", { name: "保存", exact: true }).click();

  const status = page.getByTestId("mcp-status-notion");
  await expect(status).toHaveText("需要授权");
  // 「需要授权」旁边不必再写一遍「需要在桌面端登录授权」。
  await expect(page.getByTestId("mcp-failure-notion")).toHaveCount(0);
  await expect.poll(async () => (await mcpCalls(page)).start).toContain("notion");
  await expect(status).toHaveText("正常", { timeout: 15_000 });
  await expect(page.getByTestId("mcp-failure-notion")).toHaveCount(0);
});

test("tool approval changes publish only after the explicit save", async ({ page }) => {
  await openServices(page);
  const form = await addCatalogEntry(page, "DeepWiki");
  await form.getByRole("button", { name: "保存", exact: true }).click();

  const card = page.getByTestId("mcp-card-deepwiki");
  await card.getByRole("button", { name: /工具/ }).click();
  await page.getByLabel("ask_question 审批方式").click();
  await page.getByRole("option", { name: "免审" }).click();

  expect((await mcpCalls(page)).update).toHaveLength(0);
  await card.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(async () => (await mcpCalls(page)).update.length)
    .toBe(1);
  const calls = await mcpCalls(page);
  expect(calls.update[0]?.server.autoApprove).toContain("ask_question");
});

test("write tools default to 智能 and save outside every list", async ({ page }) => {
  await openServices(page);
  const form = await addCatalogEntry(page, "DeepWiki");
  await form.getByRole("button", { name: "保存", exact: true }).click();

  const card = page.getByTestId("mcp-card-deepwiki");
  await card.getByRole("button", { name: /工具/ }).click();
  await expect(page.getByLabel("ask_question 审批方式")).toHaveText("智能");

  await page.getByLabel("read_wiki_structure 审批方式").click();
  await page.getByRole("option", { name: "停用" }).click();
  await card.getByRole("button", { name: "保存", exact: true }).click();

  await expect
    .poll(async () => (await mcpCalls(page)).update.length)
    .toBe(1);
  const calls = await mcpCalls(page);
  const server = calls.update[0]?.server as {
    autoApprove?: string[];
    requireApproval?: string[];
    disabledTools?: string[];
  };
  expect(server.disabledTools).toEqual(["read_wiki_structure"]);
  expect(server.autoApprove ?? []).not.toContain("ask_question");
  expect(server.requireApproval ?? []).not.toContain("ask_question");
  expect(server.disabledTools ?? []).not.toContain("ask_question");
});

test("deleting a service removes its card", async ({ page }) => {
  await openServices(page);
  const form = await addCatalogEntry(page, "DeepWiki");
  await form.getByRole("button", { name: "保存", exact: true }).click();

  const card = page.getByTestId("mcp-card-deepwiki");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "删除" }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await mcpCalls(page)).remove).toContain("deepwiki");
});

test("more than 100 enabled tools shows the reminder", async ({ page }) => {
  await openServices(page, "mcp-many-tools");
  await expect(
    page.getByText("工具过多会拖慢任务、增加费用，建议停用用不到的。"),
  ).toBeVisible();
});

test("an unavailable admin API replaces the page with a retry action", async ({ page }) => {
  await openServices(page, "mcp-admin-unavailable");
  await expect(
    page.getByText("无法连接云端管理接口，请检查 PUBLIC_BASE_URL 与部署状态"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
});

test("a failed connection shows the reason outside the badge", async ({ page }) => {
  await openServices(page, "mcp-probe-failed");
  const form = await addCatalogEntry(page, "DeepWiki");
  await form.getByRole("button", { name: "保存", exact: true }).click();

  const card = page.getByTestId("mcp-card-deepwiki");
  await expect(page.getByTestId("mcp-status-deepwiki")).toHaveText("连接失败");
  // 失败原因来自 Worker，长度不可控，必须整段可读，不能被徽章的 nowrap 裁掉。
  await expect(card.getByTestId("mcp-failure-deepwiki")).toHaveText(
    "dial tcp 10.0.0.12:443: connect: connection refused",
  );
});
