/**
 * settings.spec.ts — 设置页面 e2e 测试
 *
 * 依赖全局 setup 启动的 server + web。
 */

import { test, expect } from "@playwright/test";

test.describe("settings", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      url.hostname = "127.0.0.1";
      url.port = "9527";
      const headers = route.request().headers();
      const body = route.request().postData() || undefined;
      await route.continue({ url: url.toString(), headers, postData: body });
    });
  });

  test("添加并删除 provider", async ({ page }) => {
    await page.goto("/settings");

    // Wait for settings to load
    await expect(page.locator("text=Provider")).toBeVisible({ timeout: 5000 });

    // Click "+ 新建 provider"
    const addBtn = page.locator('button:has-text("新建 provider")');
    await addBtn.click();

    // Locate the dialog by its heading (ProviderEditDialog has no role="dialog")
    const dialog = page.getByText("新建 Provider").locator("..");
    await expect(dialog).toBeVisible();

    // Fill ID and 名称 using placeholder-based selectors
    await dialog.locator('input[placeholder="my-provider"]').fill("e2e-test");
    await dialog.locator('input[placeholder="我的 Provider"]').fill("E2E Test Provider");

    // Save
    const saveBtn = dialog.locator('button:has-text("保存")');
    await saveBtn.click();

    // Wait for provider to appear in list
    await expect(page.locator("text=e2e-test")).toBeVisible({ timeout: 5000 });

    // Verify it shows masked api_key (first 3 chars + "-***")
    await expect(page.locator("text=sk-***")).toBeVisible();

    // Delete the provider:
    // span "e2e-test" -> parent (inner info div) -> grandparent (provider row) -> delete button
    const deleteBtn = page
      .getByText("e2e-test")
      .first()
      .locator("..")
      .locator("..")
      .locator('button:has-text("删除")');
    page.on("dialog", (d) => d.accept());
    await deleteBtn.click();

    // Wait for it to disappear
    await expect(page.locator("text=e2e-test")).not.toBeVisible({ timeout: 5000 });
  });
});
