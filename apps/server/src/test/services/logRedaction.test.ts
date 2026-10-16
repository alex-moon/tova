import { redactForLog, redactString } from '../../main/services/logRedaction';

// Issue #145: log redaction. Chat-route errors can embed prompt content
// (provider APIs echo request bodies) and extraction errors carry extracted
// candidate text; everything argued to console.* must come through here.

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
    // Serialized structured bodies are treated as a whole: over-redaction
    // is the deliberate conservative direction (plan-145).
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
});
