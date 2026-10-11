import { expect, test, type Page } from '@playwright/test';

/*
 * Chat-task integration (issue #255, epic #251). The chat surface gains two
 * things: an embedded card for the tasks a chat started, and a "send to worker"
 * composer control. Both APIs are mocked at the page level, so this exercises
 * the client contract without a running sequencer or seeded tasks. Runs in both
 * the mobile (375x667) and desktop projects (per the standing client rules).
 */

const email = process.env.E2E_EMAIL ?? 'formsatz@gmail.com';
const sessionId = 'e2e-session-1';

const originTask = {
  id: 'e2e-task-card-1',
  status: 'running',
  instruction: 'Reconcile the latest invoice',
  origin: { kind: 'chat', sessionId },
  stepCount: 1,
  budget: { maxSteps: 25, maxCostUsd: 5, spentUsd: 0 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockAuthAndSession = async (page: Page) => {
  const e2eUser = { id: 'e2e-user-1', email, role: 'user' };
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: e2eUser }),
    }),
  );
  await page.route('**/api/chat/sessions', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ _id: sessionId, title: 'A chat' }]),
    }),
  );
  await page.route(`**/api/chat/sessions/${sessionId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ session: { _id: sessionId }, messages: [] }),
    }),
  );
};

test.beforeEach(async ({ page }) => {
  await mockAuthAndSession(page);
  await page.goto('/');
  await expect(page.getByTestId('chat-input')).toBeVisible();
});

test('shows an origin task card and links to the tasks view', async ({ page }) => {
  await page.route(/\/api\/tasks(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [originTask], nextCursor: null }),
    }),
  );

  await expect(page.getByTestId('task-card')).toBeVisible();
  const item = page.getByTestId('task-card-item');
  await expect(item).toContainText('Reconcile the latest invoice');
  await expect(page.getByTestId('task-status-running')).toBeVisible();
  expect(await item.getAttribute('href')).toBe('/tasks');
});

test('send to worker creates a task with this chat as its origin', async ({ page }) => {
  await page.route(/\/api\/tasks(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [], nextCursor: null }),
    }),
  );
  const createBodies: string[] = [];
  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() === 'POST') {
      createBodies.push(route.request().postData() ?? '');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ task: originTask }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [], nextCursor: null }),
      });
    }
  });

  const button = page.getByTestId('chat-send-to-worker');
  await expect(button).toBeDisabled();
  await page.getByTestId('chat-input').fill('Run this in the background');
  await expect(button).toBeEnabled();
  await button.click();

  await expect.poll(() => createBodies.length).toBe(1);
  const body = JSON.parse(createBodies[0]) as {
    instruction: string;
    origin: { sessionId: string };
  };
  expect(body.instruction).toBe('Run this in the background');
  expect(body.origin).toEqual({ kind: 'chat', sessionId });
});
