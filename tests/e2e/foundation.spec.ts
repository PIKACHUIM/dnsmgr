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
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: '添加 DNS 账户' })).toBeVisible();
  await page.route(/\/api\/v1\/dns\/domains\?/, (route) => route.fulfill({ json: {
    code: 0, total: 1, items: [{
      id: 1001, name: 'example.com', accountId: 1, accountName: 'test', accountType: 'cloudflare',
      remark: null, recordCount: 0, hidden: false, notice: false, categoryId: null, categoryName: null,
      expiresAt: 1893456000, checkStatus: 1,
    }],
  } }));
  await page.route('**/api/v1/dns/categories', (route) => route.fulfill({ json: { code: 0, items: [] } }));
  await page.route('**/api/v1/dns/accounts', (route) => route.fulfill({ json: { code: 0, items: [{ id: 1, name: 'test', type: 'cloudflare' }] } }));
  await page.route('**/api/v1/dns/domains/batch', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ ids: [1001], action: 'expiration-refresh' });
    await route.fulfill({ json: { code: 0, affected: 1, requested: 1 } });
  });
  await page.goto('/domain');
  await expect(page.getByRole('heading', { name: '域名列表' })).toBeVisible();
  await page.getByLabel('选择 example.com').check();
  await page.getByLabel('批量操作').selectOption('expiration-refresh');
  await page.getByRole('button', { name: '应用' }).click();
  await expect(page.locator('.notice[role="status"]')).toContainText('已将 1/1 个请求项加入到期查询队列');
  await page.route('**/api/v1/dns/domains/1000', (route) => route.fulfill({ json: {
    code: 0, domain: { id: 1000, name: 'example.com', accountName: 'test', accountType: 'cloudflare' },
  } }));
  await page.route(/\/api\/v1\/dns\/domains\/1000\/records\?/, (route) => route.fulfill({ json: {
    code: 0, page: 1, pageSize: 20, total: 2, items: [
      { id: 'a-record', name: 'www', type: 'A', value: '1.1.1.1', line: 'default', ttl: 600, mx: null, weight: null, remark: null, status: 1 },
      { id: 'url-record', name: 'web', type: 'URL', value: 'https://example.com', line: 'default', ttl: 600, mx: null, weight: null, remark: null, status: 1 },
    ],
  } }));
  await page.route('**/api/v1/dns/domains/1000/lines', (route) => route.fulfill({ json: { code: 0, lines: null, minTtl: null } }));
  await page.route('**/api/v1/dns/domains/1000/records/check', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ name: 'www', type: 'A', value: '1.1.1.1' });
    await route.fulfill({ json: { code: 0, data: { status: 'mismatch', actual: ['<img src=x onerror=alert(1)>'], expected: '1.1.1.1' } } });
  });
  await page.goto('/record/1000');
  await expect(page.getByRole('heading', { name: '解析记录', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: '返回域名列表' })).toBeVisible();
  await expect(page.getByRole('button', { name: '检测解析' })).toHaveCount(1);
  await page.getByRole('button', { name: '检测解析' }).click();
  await expect(page.getByText('解析值不一致')).toBeVisible();
  await expect(page.locator('.record-value').filter({ hasText: '<img src=x onerror=alert(1)>' })).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
  expect((await context.request.get('/api/v1/session')).status()).toBe(401);
  expect((await context.request.get('/quicklogin')).status()).toBe(404);
  expect(errors).toEqual([]);
});
