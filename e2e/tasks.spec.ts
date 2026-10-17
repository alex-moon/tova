import { expect, test, type Page } from '@playwright/test';

// Task list, detail stream, and steering composer contract, fully page-mocked.
// @see #254 #251

const email = process.env.E2E_EMAIL ?? 'formsatz@gmail.com';

const isMobileViewport = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 500;

const runningTask = {
  id: 'e2e-task-1',
  status: 'running',
  instruction: 'Summarise the newest file',
  origin: { kind: 'direct' },
  stepCount: 2,
  budget: { maxSteps: 25, maxCostUsd: 5, spentUsd: 0.0123 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const streamEvents = [
  { seq: 0, role: 'user', content: 'Summarise the newest file', step: 0, timestamp: '' },
  {
    seq: 1,
    role: 'assistant',
    content: 'Leaving a shorter note.',
    step: 0,
    model: 'e2e-mock/model',
    provider: 'deepinfra',
    timestamp: '',
    tools: [{ phase: 'result', name: 'list_files', label: 'Listing files', resultCount: 3 }],
  },
  { seq: 2, role: 'system', content: 'Step budget reached — task paused.', timestamp: '' },
];

const mockAuth = async (page: Page) => {
  const e2eUser = { id: 'e2e-user-1', email, role: 'user' };
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: e2eUser }),
    }),
  );
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: e2eUser }),
    }),
  );
};

const mockTaskApi = async (page: Page, tasks: Array<typeof runningTask>) => {
  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks, nextCursor: null }),
    });
  });
  await page.route('**/api/tasks/*/instruction', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ task: tasks[0] }),
    }),
  );
  await page.route('**/api/tasks/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ task: tasks[0], events: streamEvents }),
    });
  });
};

const openTasks = async (page: Page) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /send/i })).toBeVisible();
  if (isMobileViewport(page)) await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.locator('[data-testid="tasks-view"]')).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await mockAuth(page);
});

test('lists tasks and opens the read-only stream', async ({ page }) => {
  await mockTaskApi(page, [runningTask]);
  await openTasks(page);

  await expect(page.locator('[data-testid="task-row-e2e-task-1"]')).toBeVisible();
  await page.locator('[data-testid="task-row-e2e-task-1"]').click();

  // The "Back" affordance is the phone-only master/detail swap.
  if (isMobileViewport(page)) {
    await expect(page.locator('[data-testid="task-detail-back"]')).toBeVisible();
  }
  await expect(page.locator('[data-testid="task-tool-summary-toggle"]')).toBeVisible();
  await expect(page.locator('[data-testid="task-system-event"]')).toContainText(
    'Step budget reached',
  );
});

test('a running task offers cancel and a queued-steering composer', async ({ page }) => {
  await mockTaskApi(page, [runningTask]);
  await openTasks(page);
  await page.locator('[data-testid="task-row-e2e-task-1"]').click();

  await expect(page.locator('[data-testid="task-cancel"]')).toBeVisible();
  await page.locator('[data-testid="task-instruction-input"]').fill('focus on the PDF');
  await page.locator('[data-testid="task-instruction-send"]').click();
  await expect(page.locator('[data-sonner-toast]')).toContainText(/queued/i);
});

test('an empty task list shows the empty state', async ({ page }) => {
  await mockTaskApi(page, []);
  await openTasks(page);

  await expect(page.locator('[data-testid="task-library-empty"]')).toBeVisible();
});
