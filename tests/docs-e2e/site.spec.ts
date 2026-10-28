import { expect, test } from '@playwright/test';

const docsRoutes = [
  ['/', 'DNSMGR DNS 管理，运行在边缘'],
  ['/guide/overview', '项目概览'],
  ['/guide/local-development', '本地开发与验证'],
  ['/guide/storage', '存储模型与一致性'],
  ['/guide/platforms', '平台构建与根路径部署'],
  ['/guide/compatibility', '迁移状态与旧版兼容'],
] as const;

test('serves every page and asset from the domain root without repository prefixes', async ({ page }, testInfo) => {
  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [path, heading] of docsRoutes) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    if (path === '/') await expect(page.locator('.VPHero .text')).toHaveText(heading.replace('DNSMGR ', ''));
    else await expect(page.locator('main h1')).toContainText(heading);
    const assetPaths = await page.locator('script[src],link[rel="stylesheet"][href],link[rel="modulepreload"][href]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('src') ?? element.getAttribute('href')).filter((value): value is string => Boolean(value)));
    expect(assetPaths.length).toBeGreaterThan(0);
    for (const assetPath of assetPaths) {
      expect(new URL(assetPath, page.url()).pathname).toMatch(/^\/(?:assets|vp-icons\.css)(?:\/|$)/);
      expect(assetPath).not.toContain('/dnsmgr/');
    }
    const bounds = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
    if (path === '/') await page.screenshot({ path: testInfo.outputPath('docs-home-1440.png'), fullPage: true });
  }
  expect(failedResponses).toEqual([]);
  const fontFamilies = await page.locator('h1').first().evaluate((element) => getComputedStyle(element).fontFamily);
  expect(fontFamilies).toContain('Georgia');
});

test('keeps guide navigation usable on mobile and honors reduced motion', async ({ page }, testInfo) => {
  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 812 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'DNSMGR DNS 管理，运行在边缘' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 375) await page.screenshot({ path: testInfo.outputPath('docs-home-375.png'), fullPage: true });
  }
  await page.getByRole('button', { name: 'mobile navigation' }).click();
  await expect(page.getByRole('link', { name: '本地开发' })).toBeVisible();
  await page.getByRole('link', { name: '本地开发' }).click();
  await expect(page.locator('main h1')).toContainText('本地开发与验证');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/guide/platforms');
  await expect(page.locator('main h1')).toContainText('平台构建与根路径部署');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('script[src],link[rel="stylesheet"][href]').evaluateAll((elements) =>
    elements.every((element) => {
      const source = element.getAttribute('src') ?? element.getAttribute('href') ?? '';
      return source.startsWith('/') && !source.startsWith('/dnsmgr/');
    }))).toBe(true);
});
