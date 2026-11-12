import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { expect, test } from '@playwright/test';

interface SheetJsTestApi {
  utils: {
    book_new(): object;
    aoa_to_sheet(rows: unknown[][]): object;
    book_append_sheet(workbook: object, sheet: object, name: string): void;
  };
  write(workbook: object, options: { bookType: 'xlsx'; type: 'buffer' }): Buffer;
}

const sheetJsSource = readFileSync(new URL('../../public/static/js/xlsx.full.min.js', import.meta.url), 'utf8');
const sheetJsContext: { Buffer: typeof Buffer; XLSX?: SheetJsTestApi } = { Buffer };
runInNewContext(sheetJsSource, sheetJsContext);
const testSheetJs = sheetJsContext.XLSX;
if (!testSheetJs) throw new Error('Could not load the repository SheetJS parser');
const importWorkbook = testSheetJs.utils.book_new();
testSheetJs.utils.book_append_sheet(importWorkbook, testSheetJs.utils.aoa_to_sheet([
  ['主机记录', '记录类型', '线路类型', '记录值', 'TTL', '权重', '备注'],
  ['imported', 'A', '默认', '1.2.3.4', '600', '0', ''],
  ['mail', 'MX', '默认', 'mx.example.com | 5', '600', '0', ''],
]), 'Records');
const importWorkbookBuffer = Buffer.from(testSheetJs.write(importWorkbook, { bookType: 'xlsx', type: 'buffer' }));

test('initialization, login, session restore, responsive navigation and logout', async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  let passwordChangePayload: unknown;
  let reportedTotpEnabled = false;
  let failNextTotpBind = false;
  let malformedTotpBindResponse = false;
  let failNextTotpClose = false;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/setpwd') passwordChangePayload = request.postDataJSON();
  });
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
  await page.route('**/login', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, totpEnabled: reportedTotpEnabled } });
  });
  await page.route('**/api/v1/session', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    if (!response.ok()) {
      await route.fulfill({ response });
      return;
    }
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, totpEnabled: reportedTotpEnabled } });
  });
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: '证书订单' }).click();
  await expect(page.getByRole('heading', { name: '导入已签发证书' })).toBeVisible();
  await expect(page.getByLabel('完整证书链 PEM')).toBeVisible();
  await expect(page.getByLabel('RSA 私钥 PEM')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ACME 账户' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '申请新证书' })).toBeVisible();
  await expect(page.getByLabel('CA 环境')).toHaveValue('staging');
  await expect(page.getByText('尚无 ACME 签发任务。')).toBeVisible();
  await page.getByRole('textbox', { name: '联系邮箱' }).fill('admin@example.test');
  await page.getByLabel('CA 环境').selectOption('production');
  await expect(page.getByRole('checkbox', { name: '我明确确认将向 production CA 注册账户' })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建 ACME 账户' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '我明确确认将向 production CA 注册账户' }).check();
  await expect(page.getByRole('button', { name: '创建 ACME 账户' })).toBeEnabled();
  await page.getByLabel('CA 环境').selectOption('staging');
  await expect(page.getByRole('button', { name: '创建 ACME 账户' })).toBeEnabled();
  await page.getByRole('link', { name: '证书账户' }).click();
  await expect(page.getByRole('heading', { name: 'ACME 账户' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '导入已签发证书' })).toHaveCount(0);
  await page.getByRole('link', { name: '证书订单' }).click();
  await expect(page.getByRole('heading', { name: '导入已签发证书' })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '后台首页', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '到期提醒设置' }).click();
  await expect(page.getByRole('heading', { name: '域名到期提醒设置' })).toBeVisible();
  const noticeDays = page.getByLabel('到期提前提醒天数');
  const telegramNotice = page.getByLabel('Telegram');
  await expect(noticeDays).toHaveValue('');
  await expect(telegramNotice).toBeChecked();
  await noticeDays.fill('14,7');
  await telegramNotice.uncheck();
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.locator('.notice[role="status"]')).toContainText('到期提醒策略已保存');
  await expect(noticeDays).toHaveValue('7,14');
  await expect(telegramNotice).not.toBeChecked();
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(telegramNotice).toBeVisible();
  await telegramNotice.focus();
  await page.keyboard.press('Space');
  await expect(telegramNotice).toBeChecked();
  await page.keyboard.press('Space');
  await expect(telegramNotice).not.toBeChecked();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(page.getByLabel('Telegram')).not.toBeChecked();
  await page.getByRole('link', { name: '登录设置' }).click();
  await expect(page.getByRole('heading', { name: '登录安全设置' })).toBeVisible();
  const captchaToggle = page.getByLabel('启用图形验证码');
  await expect(captchaToggle).not.toBeChecked();
  await captchaToggle.check();
  await page.getByRole('button', { name: '保存登录设置' }).click();
  await expect(page.locator('.notice[role="status"]')).toContainText('登录设置已保存');
  await page.reload();
  await expect(page.getByLabel('启用图形验证码')).toBeChecked();
  await page.setViewportSize({ width: 375, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const mobileCaptchaToggle = page.getByLabel('启用图形验证码');
  await expect(mobileCaptchaToggle).toBeVisible();
  await mobileCaptchaToggle.focus();
  await page.keyboard.press('Space');
  await expect(mobileCaptchaToggle).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(mobileCaptchaToggle).toBeChecked();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mobileCaptchaToggle.uncheck();
  let abortCaptchaSave = true;
  await page.route('**/api/v1/system/login-captcha', async (route) => {
    if (abortCaptchaSave && route.request().method() === 'PUT') {
      abortCaptchaSave = false;
      await route.abort('failed');
      return;
    }
    await route.fallback();
  });
  await page.getByRole('button', { name: '保存登录设置' }).click();
  await expect(page.getByRole('alert')).toContainText('无法连接服务');
  await expect(mobileCaptchaToggle).toBeChecked();
  await page.unroute('**/api/v1/system/login-captcha');
  await mobileCaptchaToggle.uncheck();
  await page.getByRole('button', { name: '保存登录设置' }).click();
  await expect(page.locator('.notice[role="status"]')).toContainText('登录设置已保存');
  await expect(mobileCaptchaToggle).not.toBeChecked();
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
  const recordItems = [
    { id: 'a-record', name: 'www', type: 'A', value: '1.1.1.1', line: 'default', ttl: 600, mx: null, weight: null, remark: null, status: 1 },
    { id: 'url-record', name: 'web', type: 'URL', value: 'https://example.com', line: 'default', ttl: 600, mx: null, weight: null, remark: null, status: 1 },
  ];
  const recordQueries: string[] = [];
  await page.route(/\/api\/v1\/dns\/domains\/1000\/records\?/, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    recordQueries.push(params.get('name') ?? '');
    const items = params.get('name') === 'web' ? recordItems.filter((record) => record.name === 'web') : recordItems;
    await route.fulfill({ json: { code: 0, page: Number(params.get('page')), pageSize: 20, total: items.length, items } });
  });
  await page.route('**/api/v1/dns/domains/1000/lines', (route) => route.fulfill({ json: { code: 0, lines: null, minTtl: null } }));
  await page.route('**/api/v1/dns/domains/1000/records/check', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ name: 'www', type: 'A', value: '1.1.1.1' });
    await route.fulfill({ json: { code: 0, data: { status: 'mismatch', actual: ['<img src=x onerror=alert(1)>'], expected: '1.1.1.1' } } });
  });
  await page.route(/xlsx\.full\.min.*\.js/, (route) => route.fulfill({
    contentType: 'application/javascript', body: sheetJsSource,
  }));
  await page.route('**/api/v1/dns/domains/1000/records/batch-add', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ records: [
      { name: 'imported', type: 'A', value: '1.2.3.4', ttl: 600, line: 'default' },
      { name: 'mail', type: 'MX', value: 'mx.example.com', mx: 5, ttl: 600, line: 'default' },
    ] });
    await route.fulfill({ json: { code: 0, added: 1, failed: 1, results: [
      { index: 0, ok: true }, { index: 1, ok: false, uncertain: true, error: '上游超时' },
    ] } });
  });
  await page.goto('/record/1000');
  await expect(page.getByRole('heading', { name: '解析记录', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: '返回域名列表' })).toBeVisible();
  await page.getByLabel('主机名筛选').fill('web');
  await page.getByRole('button', { name: '筛选记录' }).click();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(1);
  await expect(page.getByText('web', { exact: true })).toBeVisible();
  await expect(page.getByText('www', { exact: true })).toHaveCount(0);
  expect(recordQueries.at(-1)).toBe('web');
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.locator('.data-table tbody tr')).toHaveCount(2);
  expect(recordQueries.at(-1)).toBe('');
  await expect(page.getByRole('button', { name: '检测解析' })).toHaveCount(1);
  await page.getByRole('button', { name: '检测解析' }).click();
  await expect(page.getByText('解析值不一致')).toBeVisible();
  await expect(page.locator('.record-value').filter({ hasText: '<img src=x onerror=alert(1)>' })).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await page.getByRole('link', { name: '表格导入' }).click();
  await expect(page.getByRole('heading', { name: '导入解析记录', exact: true, level: 1 })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'records.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: importWorkbookBuffer,
  });
  await expect(page.getByRole('heading', { name: '导入预览与结果' })).toBeVisible();
  await expect(page.getByText('mx.example.com', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '确认添加 2 条' }).click();
  await expect(page.locator('tr').filter({ hasText: 'imported' })).toContainText('添加成功');
  await expect(page.locator('tr').filter({ hasText: 'mail' })).toContainText('状态未知');
  await expect(page.locator('tr').filter({ hasText: 'mail' })).toContainText('上游超时');
  await expect(page.locator('input[type="file"]')).toBeDisabled();
  await expect(page.locator('.notice[role="status"]')).toContainText('状态未知 1 条');
  await page.getByRole('link', { name: '修改密码' }).click();
  await expect(page.getByRole('heading', { name: '修改密码', exact: true, level: 1 })).toBeVisible();
  const totpPanel = page.locator('section[aria-labelledby="totp-title"]');
  await page.route('**/totp/generate', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ password: 'browser-test-password-2026' });
    expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    await route.fulfill({ json: {
      code: 0, secret: 'JBSWY3DPEHPK3PXP', challenge: 'e2e-totp-challenge',
      uri: 'otpauth://totp/DnsMgr%3Abrowser-admin?secret=JBSWY3DPEHPK3PXP&issuer=DnsMgr&algorithm=SHA1&digits=6&period=30',
    } });
  });
  await page.route('**/totp/bind', async (route) => {
    if (failNextTotpBind) {
      failNextTotpBind = false;
      await route.abort('failed');
      return;
    }
    if (malformedTotpBindResponse) {
      malformedTotpBindResponse = false;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"code":0,' });
      return;
    }
    expect(route.request().postDataJSON()).toEqual({ challenge: 'e2e-totp-challenge', code: '123456' });
    expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    reportedTotpEnabled = true;
    await route.fulfill({ json: { code: 0, msg: '动态口令已启用，请重新登录' } });
  });
  await totpPanel.getByLabel('当前密码').fill('browser-test-password-2026');
  await totpPanel.getByRole('button', { name: '开启动态口令' }).click();
  await expect(totpPanel.getByText('JBSWY3DPEHPK3PXP')).toBeVisible();
  await expect(totpPanel.locator('canvas')).toBeVisible();
  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await totpPanel.getByLabel('认证器中的 6 位动态口令').fill('123456');
  await totpPanel.getByRole('button', { name: '完成绑定' }).click();
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
  await expect(page.getByText('动态口令已启用，请重新登录', { exact: true })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill('browser-admin');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password-2026');
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.getByRole('heading', { name: '后台首页', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '修改密码' }).click();
  await expect(totpPanel.getByText('动态口令已开启')).toBeVisible();
  await page.route('**/totp/close', async (route) => {
    if (failNextTotpClose) {
      failNextTotpClose = false;
      await route.abort('failed');
      return;
    }
    expect(route.request().postDataJSON()).toEqual({ password: 'browser-test-password-2026', code: '654321' });
    expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    reportedTotpEnabled = false;
    await route.fulfill({ json: { code: 0, msg: '动态口令已关闭，请重新登录' } });
  });
  failNextTotpClose = true;
  await totpPanel.getByLabel('当前密码').fill('browser-test-password-2026');
  await totpPanel.getByLabel('当前动态口令').fill('654321');
  page.once('dialog', (dialog) => dialog.accept());
  await totpPanel.getByRole('button', { name: '关闭动态口令' }).click();
  await expect(totpPanel.getByRole('alert')).toContainText('关闭结果未确认');
  await expect(totpPanel.getByRole('button', { name: '重新检查动态口令状态' })).toBeFocused();
  await page.reload();
  await expect(totpPanel.getByText('动态口令已开启')).toBeVisible();
  await totpPanel.getByLabel('当前密码').fill('browser-test-password-2026');
  await totpPanel.getByLabel('当前动态口令').fill('654321');
  page.once('dialog', (dialog) => dialog.accept());
  await totpPanel.getByRole('button', { name: '关闭动态口令' }).click();
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
  await expect(page.getByText('动态口令已关闭，请重新登录', { exact: true })).toBeVisible();
  await page.getByLabel('用户名', { exact: true }).fill('browser-admin');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password-2026');
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.getByRole('heading', { name: '后台首页', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '修改密码' }).click();
  await expect(page.getByRole('heading', { name: '修改密码', exact: true, level: 1 })).toBeVisible();
  failNextTotpBind = true;
  await totpPanel.getByLabel('当前密码').fill('browser-test-password-2026');
  await totpPanel.getByRole('button', { name: '开启动态口令' }).click();
  await totpPanel.getByLabel('认证器中的 6 位动态口令').fill('123456');
  await totpPanel.getByRole('button', { name: '完成绑定' }).click();
  await expect(totpPanel.getByRole('alert')).toContainText('绑定结果未确认');
  await expect(totpPanel.getByRole('button', { name: '重新检查动态口令状态' })).toBeVisible();
  await expect(totpPanel.getByRole('button', { name: '完成绑定' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: '修改密码', exact: true, level: 1 })).toBeVisible();
  await expect(totpPanel.getByRole('button', { name: '开启动态口令' })).toBeVisible();
  malformedTotpBindResponse = true;
  await totpPanel.getByLabel('当前密码').fill('browser-test-password-2026');
  await totpPanel.getByRole('button', { name: '开启动态口令' }).click();
  await totpPanel.getByLabel('认证器中的 6 位动态口令').fill('123456');
  await totpPanel.getByRole('button', { name: '完成绑定' }).click();
  await expect(totpPanel.getByRole('alert')).toContainText('绑定结果未确认');
  await expect(totpPanel.getByRole('button', { name: '重新检查动态口令状态' })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('heading', { name: '修改密码', exact: true, level: 1 })).toBeVisible();
  await expect(totpPanel.getByRole('button', { name: '开启动态口令' })).toBeVisible();
  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const passwordPanel = page.locator('section[aria-labelledby="set-password-title"]');
  const currentPassword = passwordPanel.getByLabel('当前密码');
  const newPassword = passwordPanel.getByLabel('新密码', { exact: true });
  const confirmPassword = passwordPanel.getByLabel('确认新密码');
  const newPasswordValue = '  browser-new-password-2026!  ';
  await currentPassword.fill('incorrect-password-2026');
  await newPassword.fill('short');
  await confirmPassword.fill('short');
  await page.getByRole('button', { name: '更新密码' }).click();
  await expect(page.getByRole('alert')).toContainText('12–72 个 UTF-8 字节');
  expect(passwordChangePayload).toBeUndefined();
  await newPassword.fill(newPasswordValue);
  await confirmPassword.fill('different-password-2026!');
  await page.getByRole('button', { name: '更新密码' }).click();
  await expect(page.getByRole('alert')).toContainText('两次输入的新密码不一致');
  expect(passwordChangePayload).toBeUndefined();
  await confirmPassword.fill(newPasswordValue);
  await page.getByRole('button', { name: '更新密码' }).click();
  await expect(page.getByRole('alert')).toContainText('当前密码错误');
  await expect(page.getByRole('heading', { name: '修改密码', exact: true, level: 1 })).toBeVisible();
  expect(passwordChangePayload).toEqual({ currentPassword: 'incorrect-password-2026', password: newPasswordValue });
  await currentPassword.fill('browser-test-password-2026');
  await page.getByRole('button', { name: '更新密码' }).click();
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('密码已更新，请重新登录', { exact: true })).toBeVisible();
  expect(passwordChangePayload).toEqual({ currentPassword: 'browser-test-password-2026', password: newPasswordValue });
  await page.getByLabel('用户名', { exact: true }).fill('browser-admin');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password-2026');
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.getByRole('alert')).toContainText('用户名或密码错误');
  await page.getByLabel('密码', { exact: true }).fill(newPasswordValue);
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.getByRole('heading', { name: '后台首页', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '登录设置' }).click();
  await captchaToggle.uncheck();
  await page.getByRole('button', { name: '保存登录设置' }).click();
  await expect(page.locator('.notice[role="status"]')).toContainText('登录设置已保存');
  let mockCaptchaEnabled = false;
  let rejectLoginForCaptcha = false;
  await page.route('**/verifycode', async (route) => {
    if (!mockCaptchaEnabled) {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 200, headers: { 'content-type': 'image/svg+xml', 'x-captcha-enabled': '1' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="48"><path d="M1 1L2 2"/></svg>' });
  });
  await page.route('**/login', async (route) => {
    if (rejectLoginForCaptcha && route.request().method() === 'POST') {
      rejectLoginForCaptcha = false;
      await route.fulfill({ status: 401, contentType: 'application/json', json: { code: -1, msg: '验证码错误或已过期，请刷新后重试', reason: 'INVALID_CAPTCHA' } });
      return;
    }
    await route.fallback();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
  await expect(page.getByLabel('图形验证码')).toHaveCount(0);
  mockCaptchaEnabled = true;
  rejectLoginForCaptcha = true;
  await page.getByLabel('用户名', { exact: true }).fill('browser-admin');
  await page.getByLabel('密码', { exact: true }).fill(newPasswordValue);
  await page.getByRole('button', { name: '登录控制台' }).click();
  await expect(page.getByRole('alert')).toContainText('验证码错误或已过期');
  await expect(page.getByLabel('图形验证码')).toBeVisible();
  await expect(page.locator('img[alt="登录验证码"]')).toBeVisible();
  expect((await context.request.get('/api/v1/session')).status()).toBe(401);
  expect((await context.request.get('/quicklogin')).status()).toBe(404);
  expect(errors).toEqual([]);
});
