import type { Page } from '@playwright/test';

/*
 * Shared `/api/chat/stream` mock (extracted from app.spec.ts). Fulfils the
 * SSE endpoint with configurable incremental delta events so specs can test
 * the streaming UI instead of a single blob, and captures every POST body
 * that reached it so specs can assert the ZDR request contract
 * (history vs sessionId — see App.tsx, issue #116).
 */

export interface ChatStreamCapture {
  bodies: () => string[];
}

const buildSse = (opts: { sessionId?: string; deltas: string[] }) => {
  const events = ['event: meta', 'data: {"sessionId":"e2e-mock-session"}', ''];
  for (const delta of opts.deltas) {
    events.push('event: delta', `data: ${JSON.stringify({ content: delta })}`, '');
  }
  events.push(
    'event: done',
    'data: {"complete":true,"message":{"_id":"e2e-mock-msg-1","content":"OK","modelName":"e2e-mock/model","role":"assistant"}}',
    '',
  );
  return events.join('\n');
};

export function installChatStreamMock(
  page: Page,
  { deltas = ['OK'] }: { deltas?: string[] } = {},
): ChatStreamCapture {
  const bodies: string[] = [];
  void page.route('**/api/chat/stream', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') bodies.push(req.postData() ?? '');
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildSse({ sessionId: 'e2e-mock-session', deltas }),
    });
  });
  return { bodies: () => bodies };
}
