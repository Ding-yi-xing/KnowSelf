import { expect, test } from "@playwright/test";

/**
 * 新前端骨架的导航冒烟用例。
 * 需先启动 Vite dev server（npm run dev:web）；不依赖后端数据。
 */
test("9 个页面路由可达且侧栏高亮跟随", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".nav-item[data-page='chat']")).toHaveAttribute("data-active", "true");

  const cases: Array<[string, string]> = [
    ["inbox", "/inbox"],
    ["profile", "/profile"],
    ["cards", "/cards"],
    ["journal", "/journal"],
    ["settings", "/settings"],
    ["system", "/system"],
    ["sources", "/sources"],
    ["templates", "/templates"],
  ];

  for (const [id, path] of cases) {
    await page.locator(`.nav-item[data-page='${id}']`).click();
    await expect(page).toHaveURL(new RegExp(`${path.replace("/", "\\/")}$`));
    await expect(page.locator(`.nav-item[data-page='${id}']`)).toHaveAttribute("data-active", "true");
  }

  await page.goBack();
  await expect(page).toHaveURL(/\/sources$/);
});

test("Ctrl+K 打开命令面板，Esc 关闭", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "命令面板" })).toHaveCount(0);
});
