import type { Page } from '@playwright/test';

// Shared SSE mock: configurable deltas plus POST-body capture for ZDR.
// @see #116

export interface ChatStreamCapture {
  bodies: () => string[];
}

const buildSse = (opts: { sessionId?: string; deltas: string[] }) => {
  // A zdr turn gets no session back, else the client adopts it.
  // @see #116
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
    // The real server returns no session for an incognito (zdr) chat.
    let zdr = false;
    if (req.method() === 'POST') {
      try {
        zdr = Boolean((JSON.parse(body || '{}') as { zdr?: boolean }).zdr);
      } catch {
        zdr = false;
      }
    }
    const sessionId = zdr ? undefined : 'e2e-mock-session';
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildSse({ sessionId, deltas }),
    });
  });
  return { bodies: () => bodies };
}
