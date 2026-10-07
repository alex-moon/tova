import { expect, test, type Page } from '@playwright/test';

/*
 * Responsive overflow smoke (issue #220). Loads each top-level route at phone
 * width and asserts the document itself does not overflow horizontally. This is
 * the mechanical backstop for the AGENTS.md "mobile-first" policy: a route that
 * runs content off the right edge with no affordance regresses this spec.
 *
 * Auth is fully page-mocked (same isolation pattern as assets.spec.ts) so the
 * smoke never touches seeded state and stays outside the db:password failure
 * set. The user is given the admin role so /admin renders its real surface.
 *
 * It runs in both the `mobile` (375x667) and `desktop` projects; the overflow
 * assertion is meaningful at every width, so it is not viewport-gated.
 */

const email = process.env.E2E_EMAIL ?? 'formsatz@gmail.com';

const e2eAdmin = { id: 'e2e-user-1', email, role: 'admin', zdr: false };

const mockAuth = async (page: Page) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: e2eAdmin }),
    }),
  );
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: e2eAdmin }),
    }),
  );
};

const documentOverflows = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

const routes: Array<{ path: string; ready: string }> = [
  { path: '/', ready: '[data-testid="chat-input"]' },
  { path: '/profile', ready: '[data-testid="profile-view"]' },
  { path: '/files', ready: '[data-testid="assets-view"]' },
  { path: '/admin', ready: '[data-testid="admin-view"]' },
];

for (const { path, ready } of routes) {
  test(`no horizontal overflow: ${path}`, async ({ page }) => {
    await mockAuth(page);
    await page.goto(path);
    await expect(page.locator(ready)).toBeVisible();

    expect(await documentOverflows(page)).toBe(false);
  });
}
