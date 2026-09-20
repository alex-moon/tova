/*
 * Default output-token budget for main-chat completions (#104). Without an
 * explicit `max_tokens` the DeepInfra provider defaults the output budget to
 * the model's whole context window (the #104 incident: a 40960-token request
 * on a 40960-token model leaves zero room for input), so chat always sends
 * one — sized against the routed model's `contextLength` when known.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const PROMPT_TOKEN_SLACK = 512;
const FLOOR = 1024;
const CHARS_PER_TOKEN = 4;

export const promptCharsFrom = (messages: { content: string }[]): number =>
  messages.reduce((sum, m) => sum + m.content.length, 0);

export const outputTokensFor = (contextLength: number | undefined, promptChars: number): number => {
  const envRaw = process.env.CHAT_MAX_OUTPUT_TOKENS;
  const env = envRaw !== undefined && Number.isFinite(Number(envRaw)) ? Number(envRaw) : undefined;
  const base = env && env > 0 ? env : DEFAULT_MAX_OUTPUT_TOKENS;
  // Unknown window (e.g. the env fallback model has no contextLength): send
  // the base budget untouched rather than guess.
  if (contextLength === undefined) return base;
  const budget = contextLength - Math.ceil(promptChars / CHARS_PER_TOKEN) - PROMPT_TOKEN_SLACK;
  const clamped = Math.max(Math.min(base, budget), Math.min(base, FLOOR));
  return clamped;
};
