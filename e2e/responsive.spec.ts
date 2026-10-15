import { expect, test, type Page } from '@playwright/test';

/*
 * Responsive overflow smoke (issue #220). Loads each top-level route at phone
 * width and asserts the document itself does not overflow horizontally. This is
 * the mechanical backstop for the AGENTS.md "mobile-first" policy: a route that
 * runs content off the right edge with no affordance regresses this spec.
 *
 * Auth and the admin payloads are page-mocked (same isolation pattern as
 * assets.spec.ts) so the smoke never touches seeded state and stays outside the
 * db:password failure set. The user is given the admin role and the Users/Models
 * fixtures are supplied so /admin renders its real tables rather than an empty
 * 401 state.
 *
 * It runs in both the `mobile` (375x667) and `desktop` projects; the document
 * and clipped-content assertions are meaningful at every width. The admin
 * table-integrity assertion is phone-only, because the `.responsive-table` card
 * layout it protects only applies below `md`.
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

/*
 * #220: the /admin smoke is only meaningful if the admin tables actually
 * render. Auth alone leaves every admin endpoint at 401, so the scroller shows
 * an empty error state and the "no overflow" assertion is vacuous on the route
 * the ticket was filed about. These fixtures seed the Users and Models sections
 * (loaded on mount) with wide, realistic rows so the table integrity check
 * below has something to test. The values are deliberately long (a full email,
 * a provider-qualified model id) to stress the card wrap.
 */
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

/*
 * The document-level check cannot see the headline #220 defect: a dense admin
 * table sits in an `overflow-x-auto` wrapper, so a fixed-width table scrolls
 * *inside* the wrapper and the document never overflows (375 == 375) even
 * though every trailing column is off-screen. This check targets that wrapper
 * directly: on a phone surface the table must fit its container, which is what
 * the `.responsive-table` card layout guarantees below `md`. Reverting the
 * cards (removing the class) makes the wrapper scroll and this fails.
 *
 * Only meaningful at phone width; at `md`+ the normal table layout is expected
 * to use the available width, so callers gate it on the viewport.
 */
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

/*
 * A "clipped" element is one whose content extends past the viewport's right
 * edge and is not reachable by scrolling. This is the "unaffordable overflow"
 * the ticket describes: unlike the document-level assertion above, it is not
 * masked by an inner `overflow-x-auto` wrapper, so it catches the case where
 * content is cut off with no way to scroll to it.
 *
 * Reachability is decided by the *nearest* ancestor that establishes a
 * horizontal clipping/scroll context (computed `overflow-x` in
 * auto/scroll/hidden/clip). Only that boundary governs whether the overflow is
 * reachable: if it is `auto`/`scroll` the content can be scrolled into view; if
 * it is `hidden`/`clip` the content is cut off and a scrollable ancestor
 * *above* the clip cannot recover it. Ancestors are walked until the first such
 * boundary, so an `overflow:hidden` child inside a scrollable parent is
 * correctly reported as unreachable (the earlier "any scrollable ancestor
 * anywhere above" rule missed exactly that case).
 */
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
      // The nearest clipping/scroll boundary decides reachability. Walking from
      // the element outward, the first boundary found is the one that clips it.
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

/*
 * The /tasks route (#254) renders an empty list state when the API is
 * unmocked (401), which makes the "no overflow" assertion vacuous. Seed one
 * task with a realistically long instruction so the list row and its wrapping
 * are actually exercised at phone width — and stub the detail endpoint so the
 * test can open the *detail* pane (the actual new surface: the read-only
 * stream, tool chips, budget line and the flex composer), not just the list.
 */
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

// #331: the connectors grid renders its catalog statically; only the
// connected-rows fetch needs mocking.
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

    // #254: open the task detail so the *detail* pane (stream rows, tool
    // chips, budget line, flex composer) is the surface checked for overflow,
    // not just the list. Its flex/grid layout is where a phone-width regression
    // would land, so checking only the list would be vacuous.
    if (path === '/tasks') {
      await page.locator('[data-testid="task-row-e2e-task-1"]').click();
      await expect(page.locator('[data-testid="task-tool-summary-toggle"]')).toBeVisible();
      expect(await documentOverflows(page)).toBe(false);
      expect(await clippedElements(page)).toEqual([]);
    }

    // #220 headline: on a phone the admin tables must fit, not scroll inside
    // their wrapper. Prove the table actually rendered first, so the check
    // cannot pass on an empty/401 admin page.
    if (path === '/admin' && (page.viewportSize()?.width ?? 1280) < 768) {
      await expect(
        page.locator('[data-testid="admin-users-section"] table tbody tr').first(),
      ).toBeVisible();
      expect(await adminTableOverflows(page)).toEqual([]);
    }
  });
}
