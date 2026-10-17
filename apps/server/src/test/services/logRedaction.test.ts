import { redactForLog, redactString } from '../../main/services/logRedaction';

// Log redaction: chat-route errors can embed prompt content and extraction errors carry user text; everything argued to console.* must come through here.
// @see #145
describe('redactString', () => {
  it('keeps short structural tokens verbatim', () => {
    expect(redactString('Request failed with status code 401')).toBe(
      'Request failed with status code 401',
    );
    expect(redactString('getaddrinfo ENOTFOUND api.example.com')).toBe(
      'getaddrinfo ENOTFOUND api.example.com',
    );
  });

  it('redacts double-quoted payload text', () => {
    const out = redactString('Provider said: "the user chat message being echoed onward" 400');
    expect(out).not.toContain('user chat message');
    expect(out).toContain('400');
  });

  it('redacts JSON-esque blocks', () => {
    const out = redactString(
      'Error in body: {"messages":[{"role":"user","content":"secret prompt text here"}]}',
    );
    expect(out).not.toContain('secret prompt text');
  });

  it('redacts long whitespace-free runs (b64/keys/embedded bodies)', () => {
    const out = redactString('token error '.concat('x'.repeat(80)));
    expect(out).not.toContain('xxxxxx');
  });

  it('treats empty string as empty', () => {
    expect(redactString('')).toBe('');
  });

  it('does not corrupt prose containing apostrophes (critic finding)', () => {
    const prose = "It doesn't seem to resolve for the user's request, oddly enough";
    expect(redactString(prose)).toBe(prose);
  });

  it('redacts secret-shaped assignments regardless of short value (critic finding)', () => {
    const out = redactString('auth failure: apikey=sk-abc123def456ghi789jkl');
    expect(out).not.toContain('sk-abc123');
    expect(out).toContain('apikey=');
    expect(redactString('Authorization: Bearer abc123defghijk')).not.toContain('abc123defghijk');
  });

  it('still redacts genuine single-quoted payloads', () => {
    const out = redactString("Provider said: 'the user chat message being echoed onward' 400");
    expect(out).not.toContain('user chat message');
  });

  // fs error messages quote the exact file; redacting the path cost the outage diagnosis. Paths are code-controlled, so narrowly path-shaped quoted segments survive — including the 64+-char catch-all.
  // @see #358
  it('keeps quoted filesystem paths from fs error messages', () => {
    const enoent =
      "Error: ENOENT: no such file or directory, open '/app/assets/tessdata/eng.traineddata.gz'";
    expect(redactString(enoent)).toBe(enoent);
    const eacces = "EACCES: permission denied, open '/tmp/tova-ocr-cache/eng.traineddata'";
    expect(redactString(eacces)).toBe(eacces);
    const relative = "Error: ENOENT: no such file or directory, open 'dist/main.js'";
    expect(redactString(relative)).toBe(relative);
  });

  it('keeps double-quoted filesystem paths', () => {
    const msg = 'fs read failed for "/app/apps/server/dist/services/ocr.js" during boot';
    expect(redactString(msg)).toBe(msg);
  });

  it('still redacts quoted URLs even when path-charset-clean', () => {
    const url = 'fetch failed for "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng.gz"';
    expect(redactString(url)).not.toContain('cdn.jsdelivr.net');
  });

  it('still redacts quoted token-ish runs without a file extension', () => {
    const out = redactString("reset link path '/reset/abc123def456ghi789' leaked");
    expect(out).not.toContain('abc123def456ghi789');
  });

  it('still redacts quoted prose even when it ends in a dot-something', () => {
    const out = redactString(
      'provider echoed: "please summarize my tax return.pdf and more words"',
    );
    expect(out).not.toContain('tax return');
  });

  it('still redacts a pathological 64+-char path-shaped run (backstop)', () => {
    const deep = `/app/${'a/'.repeat(40)}x.gz`;
    const out = redactString(`open '${deep}' failed`);
    expect(out).not.toContain(deep);
  });
});

describe('redactForLog', () => {
  it('keeps error name and redacts message content', () => {
    const err = new Error('provider rejected the full user prompt text pasted inside the message');
    const out = redactForLog(err);
    expect(out).toContain('Error');
    expect(out).not.toContain('pasted inside the message');
  });

  it('preserves stack frames', () => {
    const err = new Error('some message');
    const out = redactForLog(err);
    expect(out).toContain('at ');
  });

  it('keeps short status/class tokens from provider-shaped errors', () => {
    const err = Object.assign(new Error('Request failed with status code 401'), { code: '401' });
    const out = redactForLog(err);
    expect(out).toContain('status code 401');
    expect(out).toContain('code: 401');
  });

  it('redacts plain strings', () => {
    expect(redactForLog('"a quoted payload chunk above threshold"')).not.toContain('payload chunk');
  });

  it('redacts unknown objects via serialized text', () => {
    const out = redactForLog({
      message: 'upstream echoed {"content":"user secret note content again"} to us',
    });
    // Serialized structured bodies are treated as a whole: over-redaction is the deliberate conservative direction.
    // @see #145
    expect(out).not.toContain('user secret note');
  });

  it('handles circular structures without throwing', () => {
    const obj: Record<string, unknown> = { message: 'looping' };
    obj.self = obj;
    expect(() => redactForLog(obj)).not.toThrow();
  });

  it('passes through numbers, booleans and nullish values', () => {
    expect(redactForLog(429)).toBe('429');
    expect(redactForLog(false)).toBe('false');
    expect(redactForLog(null)).toBe('null');
    expect(redactForLog(undefined)).toBe('undefined');
  });

  it('handles long chat text (the actual leak shape)', () => {
    const prompt = 'Here is my diary entry: Dear diary, '.concat('today '.repeat(30));
    const out = redactForLog(new Error(`Request failed: ${prompt}`));
    expect(out).not.toContain('Dear diary');
  });

  it('keeps frames readable when the message is empty (critic finding)', () => {
    const out = redactForLog(new TypeError());
    expect(out).toContain('TypeError');
    expect(out).toContain('\n    at');
  });

  it('keeps the full fs error message with its path, as prod logs it (#358)', () => {
    // The exact shape Loki showed for the outage, minus the redaction: doubled "Error:", quoted absolute path — the whole line must stay readable.
    // @see #358
    const err = new Error(
      "Error: ENOENT: no such file or directory, open '/app/assets/tessdata/eng.traineddata.gz'",
    );
    const out = redactForLog(err);
    expect(out).toContain('ENOENT: no such file or directory');
    expect(out).toContain('/app/assets/tessdata/eng.traineddata.gz');
  });
});
