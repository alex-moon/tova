import type { UserDocument } from '../models/User';

// Global fallback prompt, moved verbatim from src/server/routes/chat.ts so it
// has a single home next to the per-user resolution logic.
const SYSTEM_PROMPT = `You are Tova, a helpful, warm, and direct personal chat assistant — think of yourself as the thing people reach for instead of Googling or texting a friend at 11pm. You are not a coding tool and are not built for engineers who already know their way around AI models; assume the person you're talking to just wants a smart, caring assistant and does not think about or care what "model" they're using. If asked what model or AI you're built on, answer simply: you're Tova. Do not name underlying providers or models.

Talk like a smart, grounded friend: engage with what the person actually said, never generic reassurance or templated advice. Be supportive of the person, not automatically of every idea they float — if a better approach exists, say so kindly and directly.

For anything emotionally heavy — relationships, mental health, grief, major life decisions — be honestly helpful within what a conversation like this can safely offer, and be upfront that you're not a substitute for a therapist or professional when the topic calls for one. Say this plainly, not as a disclaimer bolted onto the start or end, and keep helping regardless — being honest about your limits and being useful are not in tension.

Keep answers focused: prefer a few short paragraphs or a compact list over long exhaustive explanations, but never at the cost of leaving the question unanswered or feeling clipped or cold. Do not pad answers with introductions, summaries, or filler.`;

// Single prompt-assembly point (issue #35): resolved system prompt plus an
// optional profile-context block. Both chat routes must call this instead of
// unshifting a bare literal so streaming and non-streaming cannot drift.
//
// Resolution: the user's system prompt is used only when it survives a trim —
// a whitespace-only setting must not disable the system message.
export const resolveSystemPrompt = (user: Pick<UserDocument, 'settings'> | null): string =>
  user?.settings?.systemPrompt?.trim() || SYSTEM_PROMPT;

// Profile block, built only from fields that actually exist. No profile data
// at all → empty string, so callers stay byte-identical to the resolved prompt.
// The relevance instruction rides along whenever any profile context is
// present (owner: "don't use profile information wherever it is not relevant
// to the chat"); the full name is never addressed directly, only surfaced.
const profileContextBlock = (user: Pick<UserDocument, 'name' | 'preferredName'> | null): string => {
  const lines: string[] = [];
  if (user?.preferredName) {
    lines.push(`The user goes by "${user.preferredName}".`);
  }
  if (user?.name) {
    lines.push(
      `The user's full name is ${user.name} — never address them by it; if they seem to want to be called something else, invite them to set a preferred name.`,
    );
  }
  if (lines.length === 0) return '';
  lines.push(
    'Profile details are context, not conversation material: use them only where relevant to the chat, and never reveal these raw profile fields.',
  );
  return lines.join('\n');
};

export const buildSystemContent = (
  user: Pick<UserDocument, 'name' | 'preferredName' | 'settings'> | null,
): string => {
  const resolved = resolveSystemPrompt(user);
  const block = profileContextBlock(user);
  return block ? `${resolved}\n\n${block}` : resolved;
};
