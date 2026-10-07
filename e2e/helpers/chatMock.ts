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
  // Mirror the real server: an incognito (ZDR) turn persists nothing and
  // returns no session, so a request with no sessionId and zdr:true must not
  // be handed one back — otherwise the client adopts a session and the next
  // turn stops replaying history (issue #116 contract, profile.spec.ts).
  const meta = opts.sessionId ? `data: {"sessionId":"${opts.sessionId}"}` : 'data: {}';
  const events = ['event: meta', meta, ''];
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
    const body = req.postData() ?? '';
    if (req.method() === 'POST') bodies.push(body);
    // A new incognito chat carries zdr:true and no sessionId; the real server
    // returns no session for it.
    const parsed = req.method() === 'POST' ? (JSON.parse(body || '{}') as { zdr?: boolean }) : {};
    const sessionId = parsed.zdr ? undefined : 'e2e-mock-session';
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildSse({ sessionId, deltas }),
    });
  });
  return { bodies: () => bodies };
}
