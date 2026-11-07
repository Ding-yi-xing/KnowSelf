/**
 * profile.spec.ts — 核心档案 e2e 测试（1 条）
 *
 * 验证编辑核心档案后保存再刷新，内容保持不变。
 */

import { test, expect } from "@playwright/test";

test.describe("profile", () => {
  test.beforeEach(async ({ page }) => {
    // Proxy /api/ requests to the server
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      url.hostname = "127.0.0.1";
      url.port = "9527";
      const headers = route.request().headers();
      const body = route.request().postData() || undefined;
      await route.continue({ url: url.toString(), headers, postData: body });
    });
  });

  test("核心档案编辑保存后刷新仍在", async ({ page }) => {
    const uniqueToken = `e2e-test-${Date.now()}`;

    await page.goto("/profile");

    // Click edit button
    const editBtn = page.locator('[data-testid="profile-core-edit"]');
    await expect(editBtn).toBeVisible({ timeout: 5000 });
    await editBtn.click();

    // Fill in the core profile textarea
    const textarea = page.locator('[data-testid="profile-core-input"]');
    await expect(textarea).toBeVisible({ timeout: 3000 });
    await textarea.fill(`我是测试用户 ${uniqueToken}`);

    // Save
    const saveBtn = page.locator('[data-testid="profile-core-save"]');
    await saveBtn.click();

    // Wait for success toast
    const toast = page.locator('[data-testid="toast-success"]');
    await expect(toast).toBeVisible({ timeout: 5000 });

    // Reload the page
    await page.reload();

    // Check that the content is still visible after reload
    await expect(page.locator("body")).toContainText(uniqueToken, { timeout: 5000 });
  });
});
