import { expect, test, type Page } from '@playwright/test';

const email = process.env.E2E_EMAIL ?? 'formsatz@gmail.com';
const password = process.env.E2E_PASSWORD ?? 'admin';

const isMobileViewport = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 500;

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth/login', {
    data: { email, password },
  });
  // Mock the streaming chat endpoint so e2e never depends on a live LLM.
  await page.route('**/api/chat/stream', async (route) => {
    const sse = [
      'event: meta',
      'data: {"sessionId":"e2e-mock-session"}',
      '',
      'event: delta',
      'data: {"content":"OK"}',
      '',
      'event: done',
      'data: {"complete":true,"message":{"_id":"e2e-mock-msg-1","content":"OK","modelName":"e2e-mock/model","role":"assistant"}}',
      '',
    ].join('\n');
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sse,
    });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /send/i })).toBeVisible();
});

test('session survives a page reload', async ({ page }) => {
  await page.reload();
  if (isMobileViewport(page)) {
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  } else {
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible();
  }
});

test('mobile: drawer opens from hamburger and closes on selection', async ({ page }) => {
  if (!isMobileViewport(page)) return;
  const closeMenu = page.getByRole('button', { name: 'Close menu' });
  await expect(closeMenu).not.toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(closeMenu).toBeVisible();
  await page.getByRole('button', { name: 'New Chat' }).click();
  await expect(closeMenu).not.toBeVisible();
});

test('desktop/mobile: correct chrome for the viewport', async ({ page }) => {
  const hamburger = page.getByRole('button', { name: 'Open menu' });
  if (isMobileViewport(page)) {
    await expect(hamburger).toBeVisible();
  } else {
    await expect(hamburger).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible();
  }
});

test('send a message, stream a mocked reply, then switch sessions in the sidebar', async ({
  page,
}) => {
  const composer = page.locator('textarea').last();
  await composer.fill('Some prompt that triggers the stream');
  await composer.press('Enter');

  // Mocked SSE reply has already been consumed by the time this resolves.
  await expect(page.locator('p').filter({ hasText: /^OK$/ })).toBeVisible();
  // Model attribution is intentionally not asserted here under the mock;
  // see docs/ticket-1-responsive.md, "Known open question".

  // Switch to another session via the sidebar (if one exists); history renders.
  if (isMobileViewport(page)) {
    await page.getByRole('button', { name: 'Open menu' }).click();
  }
  await page.getByRole('button', { name: 'New Chat' }).first().click();
  if (isMobileViewport(page)) {
    await page.getByRole('button', { name: 'Open menu' }).click();
  }
  const target = page
    .getByRole('button', { name: /This is a test|I want to build|Earlier/ })
    .first();
  if ((await target.count()) === 0) return;
  await target.click();
  await expect(page.locator('p').filter({ hasText: /^Yes, I see it/ })).toBeVisible();
});
