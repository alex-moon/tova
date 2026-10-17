/* Default output-token budget for main-chat completions: without an explicit max_tokens the provider defaults to the model's whole context (leaving no room for input), so chat always sends one. */
// @see #104
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const PROMPT_TOKEN_SLACK = 512;
const FLOOR = 1024;
const CHARS_PER_TOKEN = 4;

export const promptCharsFrom = (
  messages: {
    content: string | { type: string; text?: string; image_url?: { url: string } }[];
  }[],
): number =>
  messages.reduce(
    (sum, m) =>
      sum +
      (typeof m.content === 'string'
        ? m.content.length
        : m.content.reduce(
            (inner, part) => inner + (part.type === 'text' ? (part.text?.length ?? 0) : 0),
            0,
          )),
    0,
  );

export const outputTokensFor = (contextLength: number | undefined, promptChars: number): number => {
  const envRaw = process.env.CHAT_MAX_OUTPUT_TOKENS;
  const env = envRaw !== undefined && Number.isFinite(Number(envRaw)) ? Number(envRaw) : undefined;
  const base = env && env > 0 ? env : DEFAULT_MAX_OUTPUT_TOKENS;
  // Unknown window: send the base budget untouched rather than guess.
  if (contextLength === undefined) return base;
  const budget = contextLength - Math.ceil(promptChars / CHARS_PER_TOKEN) - PROMPT_TOKEN_SLACK;
  const clamped = Math.max(Math.min(base, budget), Math.min(base, FLOOR));
  return clamped;
};
