import { expect, test, type Page } from '@playwright/test';
import { installChatStreamMock } from './helpers/chatMock';

/*
 * Profile flows with fully page-mocked auth and mutating endpoints (same
 * isolation pattern as assets.spec.ts): no spec reaches the real persisted
 * admin user, so ZDR toggling here cannot poison later specs (see the
 * isolation note in plan-148 — this resolves the open question by mocking
 * the mutating surface).
 */

const email = process.env.E2E_EMAIL ?? 'formsatz@gmail.com';

const isMobileViewport = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 500;

const mockUserAndApp = async (
  page: Page,
  user: Record<string, unknown>,
  opts: { sessions?: Array<{ _id: string; title: string }> } = {},
) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user }),
    }),
  );
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user }),
    }),
  );
  await page.route('**/api/chat/sessions', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(opts.sessions ?? []),
    }),
  );
};

const gotoChat = async (page: Page) => {
  await page.goto('/');
  await expect(page.getByTestId('chat-input')).toBeVisible();
};

test('profile save PATCHes the endpoint with the current fields and only changed toggles', async ({
  page,
}) => {
  // #261: a user whose stored zone already matches the browser costs no
  // timezone report — the app is in steady state, so this spec still sees
  // exactly one PATCH: the save itself.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const user = { id: 'e2e-user-1', email, zdr: false, timezone: zone };
  await mockUserAndApp(page, user);
  const patches: string[] = [];
  await page.route('**/api/profile', async (route) => {
    const req = route.request();
    if (req.method() !== 'PATCH') return route.continue();
    const patch = req.postData() ?? '';
    patches.push(patch);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { ...user, preferredName: 'Tester' } }),
    });
  });
  await page.goto('/profile');
  await expect(page.getByTestId('profile-view')).toBeVisible();

  await page.getByLabel('Preferred name').fill('Tester');
  await page.getByTestId('profile-save').click();

  expect(patches).toHaveLength(1);
  const patch = JSON.parse(patches[0]) as { preferredName?: string; zdr?: boolean };
  expect(patch.preferredName).toBe('Tester');
  expect(patch).not.toHaveProperty('zdr');
  // The saved name rides the mirror immediately (ProfileView contract).
  await expect(page.getByTestId('profile-name')).toContainText('Tester');
});

test('ZDR on: privacy note shows and the outgoing stream body replays history without sessionId', async ({
  page,
}) => {
  await mockUserAndApp(page, { id: 'e2e-user-1', email, zdr: true });
  const stream = installChatStreamMock(page);
  await gotoChat(page);

  await expect(page.getByTestId('privacy-note')).toContainText('Incognito is on for this chat');

  await page.getByTestId('chat-input').fill('ZDR question');
  await page.getByTestId('chat-input').press('Enter');

  // The mocked streamed reply renders (assistant bubble with the final text).
  await expect(page.locator('p').filter({ hasText: /^OK$/ })).toBeVisible();

  const firstBody = JSON.parse(stream.bodies()[0]) as {
    history?: Array<{ role: string; content: string }>;
    sessionId?: string;
    content: string;
  };
  expect(firstBody.sessionId).toBeUndefined();
  expect(firstBody.content).toBe('ZDR question');

  // Second turn: the first user turn is replayed in the bounded history
  // payload instead of a session id being sent.
  await page.getByTestId('chat-input').fill('Second turn');
  await page.getByTestId('chat-input').press('Enter');
  await expect(page.locator('p').filter({ hasText: /^OK$/ }).nth(1)).toBeVisible();

  const secondBody = JSON.parse(stream.bodies().at(-1) ?? '') as {
    history?: Array<{ role: string; content: string }>;
    sessionId?: string;
  };
  expect(secondBody.sessionId).toBeUndefined();
  // The replayed payload contains the prior turn (user + mocked assistant reply).
  expect(secondBody.history).toContainEqual({ role: 'assistant', content: 'OK' });
  expect(secondBody.history).toContainEqual({ role: 'user', content: 'ZDR question' });
});

test('ZDR off: the outgoing stream body carries the sessionId and no history', async ({ page }) => {
  const zdrUser = { id: 'e2e-user-1', email, zdr: false, startupChat: 'recent' };
  await mockUserAndApp(page, zdrUser, {
    sessions: [{ _id: 'e2e-session-1', title: 'Earlier chat' }],
  });
  // The session opened on startup wants its messages.
  await page.route('**/api/chat/sessions/e2e-session-1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: [] }),
    }),
  );
  const stream = installChatStreamMock(page);
  await gotoChat(page);

  await page.getByTestId('chat-input').fill('Session question');
  await page.getByTestId('chat-input').press('Enter');
  await expect(page.locator('p').filter({ hasText: /^OK$/ })).toBeVisible();

  const body = JSON.parse(stream.bodies()[0]) as { history?: unknown[]; sessionId?: string };
  expect(body.sessionId).toBe('e2e-session-1');
  expect(body).not.toHaveProperty('history');
});

test('factory reset: wrong confirm string never fires the request, right one wipes', async ({
  page,
}) => {
  const user = { id: 'e2e-user-1', email };
  await mockUserAndApp(page, user);
  const resetRequests: string[] = [];
  await page.route('**/api/profile/factory-reset', async (route) => {
    resetRequests.push(route.request().postData() ?? '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ reset: true, failedObjects: [] }),
    });
  });
  await page.goto('/profile');
  await expect(page.getByTestId('profile-view')).toBeVisible();
  await expect(page.getByTestId('profile-danger-zone')).toContainText('Factory reset');

  const button = page.getByTestId('profile-factory-reset');
  // Disabled until the typed confirmation matches exactly: even a wrong
  // lower/upper-cased string must not enable it.
  await page.getByTestId('profile-reset-confirm').fill('reset');
  await expect(button).toBeDisabled();
  expect(resetRequests).toHaveLength(0);

  await page.getByTestId('profile-reset-confirm').fill('RESET');
  await expect(button).toBeEnabled();
  await button.click();

  expect(resetRequests).toHaveLength(1);
  expect(JSON.parse(resetRequests[0])).toEqual({ confirm: 'RESET' });
});
