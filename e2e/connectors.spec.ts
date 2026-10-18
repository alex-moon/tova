import { expect, test, type Page } from '@playwright/test';

// Pins the connectors UI contract, fully page-mocked (OAuth is server-side).
// @see #331 #328 #327 #330

const email = process.env.E2E_EMAIL ?? 'formsatz@gmail.com';

const mockUserAndConnectors = async (page: Page, connectors: unknown[]) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'e2e-user-1', email, role: 'user', permissions: [], zdr: false },
      }),
    }),
  );
  await page.route('**/api/connectors', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ connectors }),
    }),
  );
};

test('grid renders the catalog with statuses and opens the modal', async ({ page }) => {
  await mockUserAndConnectors(page, [
    {
      id: 'row-1',
      scope: 'user',
      type: 'mcp.oauth',
      name: 'Notion',
      url: 'https://mcp.notion.com/mcp',
      status: 'connected',
      authConfigured: true,
      authState: 'ok',
      tools: [],
    },
  ]);
  await page.goto('/connectors');
  await expect(page.getByTestId('connectors-view')).toBeVisible();

  await expect(page.getByTestId('connector-card-notion-status')).toHaveText('Connected');
  await expect(page.getByTestId('connector-card-trello-status')).toHaveText('Connect');
  // Watchlisted entries never render.
  // @see #333
  await expect(page.getByTestId('connector-card-spotify')).toHaveCount(0);
  await expect(page.getByTestId('connector-card-slack')).toHaveCount(0);
  await expect(page.getByTestId('connectors-count')).toHaveText('1 connected');

  await page.getByTestId('connector-card-trello').click();
  await expect(page.getByTestId('connector-modal')).toBeVisible();
  await expect(page.getByTestId('connector-modal-connect')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('connector-modal')).toBeHidden();
});

test('custom add affordance expands without overflowing at phone width', async ({ page }) => {
  await mockUserAndConnectors(page, []);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/connectors');
  await expect(page.getByTestId('connectors-view')).toBeVisible();

  await page.getByTestId('connectors-custom-toggle').click();
  await expect(page.getByTestId('connector-add-save')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
