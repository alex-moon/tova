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
      provider: 'deepinfra',
      model: 'openai/gpt-oss-20b',
      tier: 'small',
      eligible: true,
      tools: true,
      vision: false,
      contextLength: 131072,
      disabledUntil: null,
      stats: [],
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

const routes: Array<{ path: string; ready: string }> = [
  { path: '/', ready: '[data-testid="chat-input"]' },
  { path: '/profile', ready: '[data-testid="profile-view"]' },
  { path: '/files', ready: '[data-testid="assets-view"]' },
  { path: '/admin', ready: '[data-testid="admin-view"]' },
];

for (const { path, ready } of routes) {
  test(`no horizontal overflow: ${path}`, async ({ page }) => {
    await mockAuth(page);
    if (path === '/admin') await mockAdminData(page);
    await page.goto(path);
    await expect(page.locator(ready)).toBeVisible();

    expect(await documentOverflows(page)).toBe(false);
    expect(await clippedElements(page)).toEqual([]);

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
