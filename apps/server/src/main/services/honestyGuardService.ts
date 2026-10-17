import { redactForLog } from './logRedaction';
import { Message } from '../models/Message';
import { inferenceService } from './inferenceService';
import { config } from '../config';
import { z } from 'zod';

// Aux model source, read lazily.
// @see #238
const guardModel = (): string => config.aux.model;

const GUARD_PROMPT =
  'You audit assistant replies for fabricated tool use. You get the assistant reply plus the ' +
  'list of tools that ACTUALLY executed during the turn (possibly none). Decide whether the ' +
  'reply asserts or implies it performed tool actions — read files, searched the web, fetched ' +
  'pages, ran code, retrieved data — that never executed. ' +
  '"claimsToolUse" is true only when the reply claims or implies actions that required a tool ' +
  'while those tools did not execute this turn — reciting results remembered from an earlier ' +
  'turn still counts as a claim. Honest statements of inability ("I cannot run tools") are false. ' +
  '"reason" is a short human-readable explanation, "" when false.';

export interface HonestyVerdict {
  flagged: boolean;
  reason: string | null;
}

// Schema-enforced verdict; a validation failure resolves with clean (no fabrication signal), which degrades to an assessed-clean message.
// @see #368
const VERDICT_SCHEMA = z.object({ claimsToolUse: z.boolean(), reason: z.string() });

// Classify a settled assistant turn and persist the verdict; never throws. Resolves the verdict so an open stream can surface it.
// @see #371
export const reviewAssistantTurn = async (
  messageId: string,
  content: string,
  executedTools: string[],
  sessionId?: string,
): Promise<HonestyVerdict | null> => {
  try {
    // Tool-free agent, same rationale as the other aux classifiers; a single user message keeps the prompt intact (the connector folds system messages into per-call instructions).
    // @see #77 #308 #198
    const completion = await inferenceService.createStructuredCompletion({
      provider: config.aux.provider,
      model: guardModel(),
      messages: [
        {
          role: 'user',
          content: `${GUARD_PROMPT}\n\nTools that actually executed this turn: ${
            executedTools.length > 0 ? executedTools.join(', ') : '(none)'
          }\n\nAssistant reply:\n${content.trim().substring(0, 4000)}`,
        },
      ],
      temperature: 0,
      // Reasoning models spend hidden reasoning tokens from this budget before any verdict text; too small and every verdict is empty or truncated (the #129 shape).
      // @see #378 #4
      max_tokens: 1024,
      ...(sessionId ? { trace: { sessionId } } : {}),
      structuredOutput: {
        schema: VERDICT_SCHEMA,
        fallbackValue: { claimsToolUse: false, reason: '' },
        jsonPromptInjection: 'auto',
        errorStrategy: 'fallback',
      },
    });
    // A starved or empty reply (reasoning models burn the budget on hidden reasoning) is garbage, not a clean verdict: leave the message unassessed rather than record a false "clean".
    // @see #378
    const raw = completion.choices[0]?.message?.content ?? '';
    if (!raw.trim() || completion.choices[0]?.finishReason === 'length') {
      console.warn(
        `Honesty guard: unclassifiable verdict (finishReason=${completion.choices[0]?.finishReason ?? 'none'}) — turn left unassessed; check the aux model's token budget.`,
      );
      return null;
    }
    const verdict: HonestyVerdict = {
      flagged: completion.object.claimsToolUse,
      reason: completion.object.reason?.trim() ? completion.object.reason.trim() : null,
    };
    await Message.findByIdAndUpdate(messageId, {
      $set: {
        honesty: { flagged: verdict.flagged, reason: verdict.reason, checkedAt: new Date() },
      },
    });
    return verdict;
  } catch (err) {
    console.error('Honesty guard error:', redactForLog(err));
    return null;
  }
};
