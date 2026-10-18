import { expect, test, type Page } from '@playwright/test';

// Upload + attach flow; Spaces PUT network-mocked (presign → PUT → confirm).
// @see #49 #34 #197

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
  // Mock the CORS preflight/PUT headers the Spaces bucket must send.
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
  // Page-level auth mock; never touches the real persisted admin user.
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
  // Mirrors the live bug: PUT succeeds but confirm fails.
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

  await expect(page.locator('[data-testid="asset-select"]').first()).toBeDisabled();
});

test('library: an edited file shows its version history and can restore one (#325)', async ({
  page,
}) => {
  const generated = {
    ...readyAsset,
    filename: 'notes.md',
    contentType: 'text/markdown',
    version: 2,
  };
  await mockAssetApi(page, [generated]);
  await page.route('**/api/assets/e2e-asset-1/content', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        asset: { ...generated, content: 'current body', format: 'markdown' },
      }),
    }),
  );
  await page.route('**/api/assets/e2e-asset-1/versions', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        versions: [
          { version: 2, size: 12, createdAt: new Date().toISOString() },
          { version: 1, size: 8, createdAt: new Date().toISOString() },
        ],
      }),
    }),
  );
  await page.route('**/api/assets/e2e-asset-1/versions/1/content', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: {
          version: 1,
          size: 8,
          content: 'old body',
          format: 'markdown',
          createdAt: new Date().toISOString(),
        },
      }),
    }),
  );
  await page.route('**/api/assets/e2e-asset-1/restore', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ asset: { ...generated, version: 3 } }),
    }),
  );

  await openFiles(page);
  await page.locator('[data-testid="asset-preview-e2e-asset-1"]').click();
  await expect(page.locator('[data-testid="assets-preview-body"]')).toContainText('current body');

  await page.locator('[data-testid="assets-history-toggle"]').click();
  await expect(page.locator('[data-testid="assets-history-item-2"]')).toContainText('Current');
  await page.locator('[data-testid="assets-history-item-1"]').click();
  await expect(page.locator('[data-testid="assets-version-banner"]')).toContainText('Version 1');
  await expect(page.locator('[data-testid="assets-version-preview"]')).toContainText('old body');
  await page.locator('[data-testid="assets-version-restore"]').click();
  await expect(page.locator('[data-testid="assets-version-preview"]')).toBeHidden();
});
