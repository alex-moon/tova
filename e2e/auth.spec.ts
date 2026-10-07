import { expect, test, type Page } from '@playwright/test';

/*
 * Authentication flow against the real local endpoints (login → session →
 * logout). Read-only with respect to the admin account: it only logs in and
 * out, so it cannot poison the persisted user state for other specs
 * (see the isolation note in plan-148).
 */

const email = process.env.E2E_EMAIL ?? 'formsatz@gmail.com';
const password = process.env.E2E_PASSWORD ?? 'password';

const openDrawer = async (page: Page) => {
  await page.getByRole('button', { name: 'Open menu' }).click();
};

test('wrong password stays on the login page with an error', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill('definitely-not-the-password');
  await page.getByTestId('login-submit').click();

  await expect(page.getByText('Login to Tova')).toBeVisible();
  await expect(page.locator('.text-destructive')).toBeVisible();
});

test('correct credentials land in the chat and survive a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('chat-input')).toBeVisible();

  await page.reload();
  // Cookie-based session: /api/auth/me resolves the user again, no re-login.
  await expect(page.getByTestId('chat-input')).toBeVisible();
});

test('logout returns to the login page and the session stays gone after a reload', async ({
  page,
}) => {
  await page.request.post('/api/auth/login', { data: { email, password } });
  await page.goto('/');
  await expect(page.getByTestId('chat-input')).toBeVisible();

  if ((page.viewportSize()?.width ?? 1280) <= 500) await openDrawer(page);
  await page.getByRole('button', { name: 'Logout' }).click();

  await expect(page.getByText('Login to Tova')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Login to Tova')).toBeVisible();
});
