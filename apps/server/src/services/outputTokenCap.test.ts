import { outputTokensFor, promptCharsFrom } from './outputTokenCap';

describe('outputTokenCap', () => {
  afterEach(() => {
    delete process.env.CHAT_MAX_OUTPUT_TOKENS;
  });

  describe('promptCharsFrom', () => {
    it('sums message content lengths', () => {
      expect(promptCharsFrom([{ content: 'abcd' }, { content: 'ef' }])).toBe(6);
    });

    it('returns 0 for an empty prompt', () => {
      expect(promptCharsFrom([])).toBe(0);
    });

    it('counts only text parts of a multimodal message (#115)', () => {
      expect(
        promptCharsFrom([
          {
            content: [
              { type: 'text', text: 'abcd' },
              { type: 'image_url', image_url: { url: 'https://spaces.example.com/x.png' } },
            ],
          },
        ]),
      ).toBe(4);
    });

    it('treats an empty or malformed part array as zero chars, not a crash', () => {
      expect(promptCharsFrom([{ content: [] }, { content: [{ type: 'text' }] }])).toBe(0);
    });
  });

  describe('outputTokensFor', () => {
    it('returns the 8192 default for an unknown context length', () => {
      expect(outputTokensFor(undefined, 0)).toBe(8192);
    });

    it('honours CHAT_MAX_OUTPUT_TOKENS when valid and positive', () => {
      process.env.CHAT_MAX_OUTPUT_TOKENS = '4096';
      expect(outputTokensFor(undefined, 0)).toBe(4096);
    });

    it('ignores invalid and non-positive env values', () => {
      process.env.CHAT_MAX_OUTPUT_TOKENS = 'nope';
      expect(outputTokensFor(undefined, 0)).toBe(8192);
      process.env.CHAT_MAX_OUTPUT_TOKENS = '0';
      expect(outputTokensFor(undefined, 0)).toBe(8192);
      process.env.CHAT_MAX_OUTPUT_TOKENS = '-5';
      expect(outputTokensFor(undefined, 0)).toBe(8192);
    });

    it('clamps a too-large env base down to the window budget', () => {
      process.env.CHAT_MAX_OUTPUT_TOKENS = '200000';
      // ceil(12737/4)=3185; 40960-3185-512 = 37263.
      expect(outputTokensFor(40960, 12737)).toBe(40960 - 3185 - 512);
    });

    it('clamps the base to a small model window minus the prompt estimate and slack', () => {
      // 12737 chars ≈ 3185 tokens; Qwen3-14B window 40960.
      expect(outputTokensFor(40960, 12737)).toBe(8192);
      // A tight window leaves only what the prompt did not use.
      expect(outputTokensFor(2048, 1000)).toBe(2048 - Math.ceil(1000 / 4) - 512);
    });

    it('scales the clamp with the prompt size', () => {
      // ceil(1000/4)=250 -> 2048-250-512; 432 extra chars = 108 more tokens.
      expect(outputTokensFor(2048, 1000)).toBe(1286);
      expect(outputTokensFor(2048, 1432)).toBe(1178);
    });

    it('never sits below the 1024 floor', () => {
      expect(outputTokensFor(1100, 500)).toBe(1024);
    });
  });
});
