/**
 * navigation.spec.ts — 导航与快捷键 e2e 测试
 */

import { test, expect } from "@playwright/test";

test.describe("navigation", () => {
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

  test("导航到各页面", async ({ page }) => {
    await page.goto("/");

    // Click "档案" nav item
    await page.locator('[data-testid="nav-profile"]').click();
    await expect(page.locator('h1:has-text("核心档案")')).toBeVisible({ timeout: 5000 });

    // Click "设置" nav item
    await page.locator('[data-testid="nav-settings"]').click();
    await expect(page.locator("text=界面偏好")).toBeVisible({ timeout: 5000 });

    // Click "对话" nav item (back to chat)
    await page.locator('[data-testid="nav-chat"]').click();
    await expect(page.locator("text=对话")).toBeVisible({ timeout: 5000 });
  });

  test("Cmd+K 打开命令面板", async ({ page }) => {
    await page.goto("/");

    // Press Cmd+K (or Ctrl+K on Windows/Linux)
    await page.keyboard.press("Control+k");

    // Command palette should be visible
    const palette = page.locator('[role="dialog"]');
    await expect(palette).toBeVisible({ timeout: 3000 });

    // Type "设置" to filter
    const searchInput = palette.locator('input[placeholder="搜索命令..."]');
    await expect(searchInput).toBeVisible();
    await searchInput.fill("设置");

    // Should show "设置" command
    await expect(palette.locator("text=设置")).toBeVisible();

    // Press Escape to close
    await page.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: 3000 });
  });
});
