import { auxCompletion, AUX_INPUT_CHAR_CAP } from './auxCompletion';
import { Message } from '../../models/Message';
import { systemOneDecide, isNoulAnswer, type DecisionQuestion } from './systemOneClient';
import { z } from 'zod';

const GUARD_PROMPT =
  'You audit assistant replies for fabricated tool use. You get the assistant reply plus the ' +
  'list of tools that ACTUALLY executed during the turn (possibly none). Decide whether the ' +
  'reply asserts or implies it performed tool actions — read files, searched the web, fetched ' +
  'pages, ran code, retrieved data — that never executed. ' +
  'Reciting results remembered from an earlier turn still counts as a claim. ' +
  'Honest statements of inability ("I cannot run tools") are false.';

export interface HonestyVerdict {
  flagged: boolean;
  confidence: number | null;
}

// Schema-enforced verdict; validation failure resolves clean.
// @see #368
const VERDICT_SCHEMA = z.object({ claimsToolUse: z.boolean(), reason: z.string() });

// One noul question carries the whole guard; confidence is the audit trail.
// @see #426
const GUARD_QUESTION: Record<string, DecisionQuestion> = {
  claimsToolUse: {
    type: 'noul',
    instructions:
      'Does the reply assert or imply it performed tool actions (read files, searched the web, ' +
      'fetched pages, ran code, retrieved data) that never executed this turn? Reciting results ' +
      'remembered from an earlier turn still counts as a claim. Honest statements of inability ' +
      '("I cannot run tools") do not.',
  },
};

const composeGuardState = (content: string, executedTools: string[]): string =>
  `Tools that actually executed this turn: ${
    executedTools.length > 0 ? executedTools.join(', ') : '(none)'
  }\n\nAssistant reply:\n` + content.trim().substring(0, AUX_INPUT_CHAR_CAP);

const classifyViaDecision = async (
  content: string,
  executedTools: string[],
): Promise<HonestyVerdict | null> => {
  const answers = await systemOneDecide(
    'Honesty guard',
    composeGuardState(content, executedTools),
    GUARD_QUESTION,
  );
  if (!isNoulAnswer(answers?.claimsToolUse)) return null;
  return { flagged: answers.claimsToolUse.noul >= 0.5, confidence: answers.claimsToolUse.noul };
};

// Classify an assistant turn; never throws, null when unassessable.
// @see #371 #378
export const classifyAssistantTurn = async (
  content: string,
  executedTools: string[],
  sessionId?: string,
): Promise<HonestyVerdict | null> => {
  const decided = await classifyViaDecision(content, executedTools);
  if (decided) return decided;
  // Tool-free agent; a single user message keeps the prompt intact.
  // @see #77 #308 #198
  const completion = await auxCompletion<z.infer<typeof VERDICT_SCHEMA>>('Honesty guard', {
    messages: [
      {
        role: 'user',
        content: `${GUARD_PROMPT}\n\n${composeGuardState(content, executedTools)}`,
      },
    ],
    temperature: 0,
    // Reasoning tokens come from this budget; too small starves verdicts.
    // @see #378 #4 #129
    max_tokens: 1024,
    ...(sessionId ? { trace: { sessionId } } : {}),
    structuredOutput: {
      schema: VERDICT_SCHEMA,
      fallbackValue: { claimsToolUse: false, reason: '' },
      jsonPromptInjection: 'auto',
      errorStrategy: 'fallback',
    },
  });
  if (!completion) return null;
  // An empty reply is garbage, not a clean verdict: leave unassessed.
  // @see #378
  const raw = completion.choices[0]?.message?.content ?? '';
  if (!raw.trim() || completion.choices[0]?.finishReason === 'length') {
    console.warn(
      `Honesty guard: unclassifiable verdict (finishReason=${completion.choices[0]?.finishReason ?? 'none'}) — turn left unassessed; check the aux model's token budget.`,
    );
    return null;
  }
  return { flagged: completion.object.claimsToolUse, confidence: null };
};

// Classify a settled turn, persist the verdict; never throws.
// @see #371
export const reviewAssistantTurn = async (
  messageId: string,
  content: string,
  executedTools: string[],
  sessionId?: string,
): Promise<HonestyVerdict | null> => {
  const verdict = await classifyAssistantTurn(content, executedTools, sessionId);
  if (!verdict) return null;
  await Message.findByIdAndUpdate(messageId, {
    $set: {
      honesty: { flagged: verdict.flagged, confidence: verdict.confidence, checkedAt: new Date() },
    },
  });
  return verdict;
};
