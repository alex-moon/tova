import { expect, test, type Page } from '@playwright/test';

// Overflow smoke: every top-level route must not overflow horizontally.
// @see #220

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

// Seeds admin Users/Models fixtures so /admin checks hit real rows.
// @see #220
const mockAdminData = async (page: Page) => {
  const now = new Date().toISOString();
  const users = Array.from({ length: 4 }, (_, i) => ({
    id: `e2e-user-${i}`,
    email: `a-fairly-long-address-${i}@example.com`,
    role: i === 0 ? 'admin' : 'user',
    permissions: ['routing'],
    hasGoogle: i % 2 === 0,
    createdAt: now,
    updatedAt: now,
  }));
  const models = [
    {
      id: 'e2e-model-0',
      modelId: 'openai/gpt-oss-20b',
      label: 'openai/gpt-oss-20b',
      eligible: true,
      tools: true,
      vision: false,
      contextLength: 131072,
      inputPrice: 0.1,
      outputPrice: 0.3,
      providers: [
        {
          provider: 'deepinfra',
          modelId: 'openai/gpt-oss-20b',
          enabled: true,
          ttftMs: 320,
          ttftSamples: 12,
          disabledUntil: null,
        },
        {
          provider: 'fireworks',
          modelId: 'accounts/fireworks/models/gpt-oss-20b',
          enabled: true,
          disabledUntil: null,
        },
      ],
    },
  ];
  await page.route('**/api/admin/users', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(users),
    }),
  );
  await page.route('**/api/admin/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models, errors: [] }),
    }),
  );
};

// Catches tables scrolling inside an overflow-x-auto wrapper.
// @see #220
const adminTableOverflows = (page: Page) =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="admin-scroller"] .overflow-x-auto'),
    )
      .filter((wrapper) => wrapper.querySelector('table') !== null)
      .filter((wrapper) => wrapper.scrollWidth > wrapper.clientWidth + 1)
      .map((wrapper) => ({
        testid: wrapper.querySelector('table')?.getAttribute('data-testid') ?? null,
        scrollWidth: wrapper.scrollWidth,
        clientWidth: wrapper.clientWidth,
      })),
  );

const documentOverflows = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

// Elements past the right edge that a clipping ancestor hides, not scrolls.
const clippedElements = (page: Page) =>
  page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const clippingContext = (el: Element): 'scroll' | 'hidden' | null => {
      const v = getComputedStyle(el).overflowX;
      if (v === 'auto' || v === 'scroll') return 'scroll';
      if (v === 'hidden' || v === 'clip') return 'hidden';
      return null;
    };
    const offenders: Array<{ tag: string; testid: string | null; right: number }> = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= viewport + 1) continue;
      let reachable = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ctx = clippingContext(p);
        if (ctx === null) continue;
        reachable = ctx === 'scroll';
        break;
      }
      if (reachable) continue;
      offenders.push({
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute('data-testid'),
        right: Math.round(rect.right),
      });
      if (offenders.length >= 10) break;
    }
    return offenders;
  });

// Seeds a task and stubs its detail so list and pane are exercised, not a 401.
// @see #254
const mockTasks = async (page: Page) => {
  const task = {
    id: 'e2e-task-1',
    status: 'running',
    instruction: 'Summarise the newest file and leave a short note with every action item you find',
    origin: { kind: 'direct' },
    stepCount: 2,
    budget: { maxSteps: 25, maxCostUsd: 5, spentUsd: 0.0123 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const events = [
    { seq: 0, role: 'user', content: task.instruction, step: 0, timestamp: '' },
    {
      seq: 1,
      role: 'assistant',
      content: 'I listed the files and found a few action items worth noting in detail.',
      step: 1,
      model: 'e2e-mock/model',
      provider: 'deepinfra',
      timestamp: '',
      tools: [{ phase: 'result', name: 'list_files', label: 'Listing files', resultCount: 3 }],
    },
    { seq: 2, role: 'system', content: 'Step budget reached — task paused.', timestamp: '' },
  ];
  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [task], nextCursor: null }),
    });
  });
  await page.route('**/api/tasks/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ task, events }),
    });
  });
};

// The connectors catalog is static; only connected-rows fetch needs mocking.
// @see #331
const mockConnectors = async (page: Page) => {
  await page.route('**/api/connectors', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ connectors: [] }),
    }),
  );
};

const routes: Array<{ path: string; ready: string }> = [
  { path: '/', ready: '[data-testid="chat-input"]' },
  { path: '/profile', ready: '[data-testid="profile-view"]' },
  { path: '/files', ready: '[data-testid="assets-view"]' },
  { path: '/tasks', ready: '[data-testid="tasks-view"]' },
  { path: '/connectors', ready: '[data-testid="connectors-view"]' },
  { path: '/admin', ready: '[data-testid="admin-view"]' },
];

for (const { path, ready } of routes) {
  test(`no horizontal overflow: ${path}`, async ({ page }) => {
    await mockAuth(page);
    if (path === '/admin') await mockAdminData(page);
    if (path === '/tasks') await mockTasks(page);
    if (path === '/connectors') await mockConnectors(page);
    await page.goto(path);
    await expect(page.locator(ready)).toBeVisible();

    expect(await documentOverflows(page)).toBe(false);
    expect(await clippedElements(page)).toEqual([]);

    // Check the detail pane too, not just the list; regressions land here.
    // @see #254
    if (path === '/tasks') {
      await page.locator('[data-testid="task-row-e2e-task-1"]').click();
      await expect(page.locator('[data-testid="task-tool-summary-toggle"]')).toBeVisible();
      expect(await documentOverflows(page)).toBe(false);
      expect(await clippedElements(page)).toEqual([]);
    }

    // Admin tables must fit on a phone, not scroll in their wrapper.
    // @see #220
    if (path === '/admin' && (page.viewportSize()?.width ?? 1280) < 768) {
      await expect(
        page.locator('[data-testid="admin-users-section"] table tbody tr').first(),
      ).toBeVisible();
      expect(await adminTableOverflows(page)).toEqual([]);
    }
  });
}
