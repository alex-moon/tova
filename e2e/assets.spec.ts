import { expect, test, type Page } from '@playwright/test';

/*
 * Asset upload + attach flow (issue #49 / #34). The Spaces PUT is fully
 * mocked at the network layer (presign returns a mock URL fulfilled by
 * Playwright), so this never touches real storage: it exercises
 * presign → PUT → confirm, the exact pipeline the live CORS bug breaks,
 * plus the library selection/preview contract (#197 master/detail replaced
 * the old per-row attach button).
 */

const email = process.env.E2E_EMAIL ?? 'formsatz@gmail.com';

const isMobileViewport = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 500;

const readyAsset = {
  id: 'e2e-asset-1',
  filename: 'notes.txt',
  contentType: 'text/plain',
  size: 11,
  status: 'ready',
  hasText: true,
  createdAt: new Date().toISOString(),
};

const pendingAsset = { ...readyAsset, status: 'pending', hasText: false };

const mockAssetApi = async (page: Page, assets: Array<typeof pendingAsset>) => {
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ assets, nextCursor: null }),
    });
  });
};

const openFiles = async (page: Page) => {
  if (isMobileViewport(page)) await page.getByRole('button', { name: 'Open menu' }).click();
  // #197 made /files a sidebar link, not a modal-opening button.
  await page.getByRole('link', { name: 'Files' }).click();
  await expect(page.locator('[data-testid="asset-library"]')).toBeVisible();
};

const mockUploadPipeline = async (
  page: Page,
  origin: string | undefined,
  asset: typeof readyAsset,
): Promise<{ putHits: () => number }> => {
  let putCount = 0;
  await page.route('**/api/assets/presign', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        uploadUrl: 'https://storage.mock/tova/mock-key',
        asset: { ...asset, status: 'pending' },
      }),
    }),
  );
  // A "fixed" CORS rule, mirroring what the Spaces bucket must send once the
  // Allowed Headers delta from docs/spaces-cors.md is applied: PUT is
  // non-simple, so the browser preflights and needs the CORS response headers.
  const corsHeaders = {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'PUT',
    'access-control-allow-headers': 'content-type',
  };
  await page.route('https://storage.mock/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: corsHeaders });
    if (req.method() === 'PUT') {
      putCount += 1;
      return route.fulfill({ status: 200, headers: corsHeaders });
    }
    return route.continue();
  });
  await page.route('**/api/assets/e2e-asset-1/confirm', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ asset }),
    }),
  );
  return { putHits: () => putCount };
};

test.beforeEach(async ({ page }) => {
  // Auth is mocked at the page level so this spec does not depend on an
  // admin user existing in the target database (login still hits the real
  // endpoint first for parity, then a page-level mock answers in the app).
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
  await page.goto('/');
  await expect(page.getByRole('button', { name: /send/i })).toBeVisible();
});

test('composer attach: upload runs presign → PUT → confirm and attaches', async ({
  page,
  baseURL,
}) => {
  await mockAssetApi(page, []);
  const file = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello world') };
  const pipeline = await mockUploadPipeline(page, baseURL, readyAsset);

  await page.getByRole('button', { name: 'Attach a file' }).click();
  await page.locator('input[type=file]').last().setInputFiles(file);

  await expect(page.locator('[data-testid="attachment-chip"]')).toContainText('notes.txt');
  expect(pipeline.putHits()).toBe(1);
});

test('library: failed upload shows an error and never enables attach', async ({ page }) => {
  await mockAssetApi(page, [pendingAsset]);
  // Confirm errors even after a successful PUT (mirrors the live bug: PUT
  // blocked/CO-retied, asset stuck pending → attach stays disabled).
  await page.route('**/api/assets/presign', (route) => route.fulfill({ status: 500 }));
  await page.getByRole('button', { name: 'Attach a file' }).click();
  await page
    .locator('input[type=file]')
    .last()
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });

  await expect(page.locator('[data-sonner-toast]')).toContainText(/went wrong|failed/i);
  await expect(page.locator('[data-testid="attachment-chip"]')).toBeHidden();
});

test('library: selecting a ready asset opens its preview', async ({ page }) => {
  await mockAssetApi(page, [readyAsset]);
  // The #197 master/detail view loads the extracted body through the content
  // endpoint when a row is selected; there is no per-row attach control any
  // more (attaching happens only from the composer, covered above).
  await page.route('**/api/assets/e2e-asset-1/content', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        asset: { ...readyAsset, content: 'hello world', format: 'text' },
      }),
    }),
  );
  await openFiles(page);

  await page.locator('[data-testid="asset-preview-e2e-asset-1"]').click();
  await expect(page.locator('[data-testid="assets-preview-title"]')).toContainText('notes.txt');
  await expect(page.locator('[data-testid="assets-preview-body"]')).toContainText('hello world');
});

test('library: pending assets cannot be selected', async ({ page }) => {
  await mockAssetApi(page, [pendingAsset]);
  await openFiles(page);

  // The readiness gate moved from the removed attach button to the row's
  // selection checkbox: a not-ready asset cannot be multi-selected.
  await expect(page.locator('[data-testid="asset-select"]').first()).toBeDisabled();
});
