import { expect, test } from '@playwright/test';

test('initialization, login, session restore, responsive navigation and logout', async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/install');
  await expect(page.getByRole('heading', { name: '初始化管理系统' })).toBeVisible();
  await page.getByLabel('安装令牌', { exact: true }).fill('local-browser-test-setup-token-2026');
  await page.getByLabel('管理员用户名', { exact: true }).fill('browser-admin');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password-2026');
  await page.getByLabel('确认密码', { exact: true }).fill('browser-test-password-2026');
  await page.screenshot({ path: testInfo.outputPath('install-1440.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '初始化并创建账户' }).click();
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill('browser-admin');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password-2026');
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.getByRole('heading', { name: '后台首页', exact: true })).toBeVisible();
  await expect(page.locator('.environment-panel')).toContainText('local');
  await expect(page.locator('.environment-panel')).toContainText('d1');
  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === 'user_token')?.httpOnly).toBe(true);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: '后台首页', exact: true })).toBeVisible();
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator('.environment-panel')).toContainText('local');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`console-${width}.png`), fullPage: true, animations: 'disabled' });
    if (width < 901) {
      const open = page.getByRole('button', { name: '打开导航菜单' });
      await open.click();
      await expect(page.getByRole('dialog', { name: '功能导航' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(open).toBeFocused();
    }
  }
  await page.goto('/record/1000');
  await expect(page.getByRole('heading', { name: '此模块尚未移植' })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
  expect((await context.request.get('/api/v1/session')).status()).toBe(401);
  expect((await context.request.get('/quicklogin')).status()).toBe(404);
  expect(errors).toEqual([]);
});
