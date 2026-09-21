import { expect, test, type Page } from '@playwright/test';
import { installChatStreamMock } from './helpers/chatMock';

/*
 * Send-a-chat + streamed reply. Auth uses the real local endpoints (same
 * pattern as app.spec.ts); the stream is the shared mocked SSE endpoint so
 * the spec never depends on a live LLM. The mock splits the reply across
 * several delta events to exercise incremental rendering, not a single blob.
 */

const email = process.env.E2E_EMAIL ?? 'formsatz@gmail.com';
const password = process.env.E2E_PASSWORD ?? 'admin';

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth/login', {
    data: { email, password },
  });
  await page.goto('/');
  await expect(page.getByTestId('chat-input')).toBeVisible();
});

test('send a chat: user message first, then the streamed reply', async ({ page }) => {
  const stream = installChatStreamMock(page, { deltas: ['Hel', 'lo, ', 'streamed ', 'reply'] });

  await page.getByTestId('chat-input').fill('Some prompt that triggers the stream');
  // User message should render before the stream resolves.
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  await page.getByTestId('chat-input').press('Enter');

  await page.getByTestId('chat-input').fill('');
  await expect(page.getByText('Some prompt that triggers the stream')).toBeVisible();
  await expect(page.getByText(/Hello, streamed reply/)).toBeVisible();

  // The outgoing request must have hit the mocked stream endpoint.
  expect(stream.bodies()).toHaveLength(1);
  const body = JSON.parse(stream.bodies()[0]) as { content?: string };
  expect(body.content).toBe('Some prompt that triggers the stream');
});
