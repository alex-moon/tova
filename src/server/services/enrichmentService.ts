import { Asset } from '../models/Asset';
import { config } from '../config';
import { inferenceService } from './inferenceService';
import { redactForLog } from './logRedaction';
import { fileLibraryIndex } from './promptAssembly';

/*
 * #238: the enrichment pass.
 *
 * The tier-era guard classifier was a "first tiny fast model pass" whose AUX
 * `files` vote decided whether to inject the user's file-library index into the
 * system prompt (#214). #232/#233 deleted the classifier's *routing* role but
 * the owner kept (and wants to expand) the *enrichment* role. This service is
 * that pass: a single cheap tool-free aux call that judges whether the user is
 * likely referring to a file in their library, plus the bounded library read
 * that renders the index.
 *
 * It is deliberately narrow: the `files` signal is preserved verbatim from the
 * retired guard, and no new signals are invented until the owner supplies the
 * concrete expansion list (see docs/plan-238-aux-enrichment.md follow-ups).
 *
 * Enrichment is never load-bearing: a failed call, a slow call, an unparseable
 * reply, or an empty library all degrade to "no block", never an error.
 */

/*
 * Kill switch, mirroring ENTITY_GRAPH_ENABLED: enrichment (an extra aux call
 * per turn) can be turned off without a deploy. Default ON — the pre-#232 guard
 * ran on every text turn, so this preserves that behaviour.
 */
export const isEnrichmentEnabled = (): boolean => {
  const raw = process.env.ENRICHMENT_ENABLED;
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};

/*
 * The `files` vote prompt, narrowed from the retired five-key guard prompt to
 * the single enrichment key. The wording for `files` is unchanged so the
 * judgement matches the pre-#232 guard byte-for-byte.
 */
export const FILES_VOTE_PROMPT = `Classify the user's current request below by replying with ONLY one JSON object, nothing else, with exactly this one key, "yes" or "no":

{"files":"yes|no"}

- files: is the user likely referring to a specific file in their library — an existing uploaded document they expect you to find, open, or quote ("summarise my CV", "what did the lease say about pets", "check the Q3 report")? Say "no" when they ask you to create or save a new file, and "no" for general chat that does not point at an existing document.`;

/*
 * Extract the LAST balanced, JSON-parseable {...} object in the reply that
 * carries the `files` key. Ported from the retired guard's `parseGuardVotes`:
 * reasoning models emit chain-of-thought ahead of the answer, so the last
 * vote-shaped object wins; decoy objects without the key are skipped.
 */
export const parseFilesVote = (raw: string): Record<string, unknown> | null => {
  const objects: Record<string, unknown>[] = [];
  let start = raw.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const obj: unknown = JSON.parse(raw.slice(start, i + 1));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
              objects.push(obj as Record<string, unknown>);
            }
          } catch {
            // Not valid JSON from this '{' — keep scanning.
          }
          break;
        }
      }
    }
    start = raw.indexOf('{', start + 1);
  }
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    if ('files' in objects[i]) return objects[i];
  }
  return null;
};

/*
 * The `files` vote → "is the user likely referring to a specific file in their
 * library?" Ported from `guardFilesVoteFromReply`: unlike the tier votes, a
 * MISSING key is a no (an unparseable reply must not trigger the read), and
 * explicit "no" → false; any other present value → true (doubt prefers
 * enrichment — the block is cheap and harmless). No vote object → false.
 */
export const filesVoteFromReply = (raw: string): boolean => {
  const votes = parseFilesVote(raw);
  if (!votes) return false;
  return (
    String(votes.files ?? '')
      .trim()
      .toLowerCase() !== 'no'
  );
};

// #238: aux model source for the enrichment call, read lazily.
const enrichmentModel = (): string => config.aux.model;

/*
 * One tool-free aux call: does the current request point at a library file?
 * Never throws — any failure (call, parse, tool rejection) degrades to false.
 * History rides in the prompt so a short continuation ("open it") can inherit
 * the previous turn's file intent, mirroring the retired guard.
 */
export const classifyFileIntent = async (
  query: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
): Promise<boolean> => {
  const transcript = history.length
    ? `\nConversation so far, oldest first:\n${history
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n')}\n`
    : '';
  try {
    const completion = await inferenceService.createToolFreeCompletion({
      provider: config.aux.provider,
      model: enrichmentModel(),
      messages: [
        {
          role: 'user',
          content: `${FILES_VOTE_PROMPT}\n${transcript}\nCurrent request: ${query}`,
        },
      ],
      temperature: 0,
      max_tokens: 512,
      trace: { tags: ['enrichment:files'] },
    });
    return filesVoteFromReply(completion.choices[0]?.message?.content ?? '');
  } catch (err) {
    console.error('Enrichment classify error:', redactForLog(err));
    return false;
  }
};

/*
 * #214/#238: bounded library index for the system prompt, mirroring
 * `list_files` exactly — newest first, 20 rows, the 21st only sets the
 * truncation notice — so the injected list and the tool agree. Never throws: a
 * prompt-enrichment read must not degrade a chat turn (same posture as the
 * entity-graph block). Moved here from the chat route with the enrichment pass.
 */
export const libraryIndexFor = async (userId: string): Promise<string> => {
  try {
    const rows = await Asset.find({ userId, status: 'ready' })
      .sort({ _id: -1 })
      .limit(21)
      .select('filename contentType createdAt');
    return fileLibraryIndex(rows as unknown as Parameters<typeof fileLibraryIndex>[0]);
  } catch (err) {
    console.error('File library retrieval error:', redactForLog(err));
    return '';
  }
};

/*
 * #238: bound the classification by `ENRICHMENT_TIMEOUT_MS`. `createToolFreeCompletion`
 * cannot be aborted today, so a timeout abandons the pending call and treats it
 * as "no signal" — the abandoned promise still settles in the background and
 * its rejection is swallowed. Keeps the pre-pass from ever delaying a turn by
 * more than the cap.
 */
const classifyWithinTimeout = async (
  query: string,
  history: { role: 'user' | 'assistant'; content: string }[],
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), config.aux.enrichmentTimeoutMs);
  });
  try {
    return await Promise.race([classifyFileIntent(query, history), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/*
 * Compose the enrichment pass: gate → classify → (only on a positive vote)
 * read the library → render the index. Returns '' when disabled, when the
 * vote is negative, when the call times out, or when the library is empty.
 * Never throws.
 */
export const enrichmentLibraryBlock = async (
  query: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  userId: string,
): Promise<string> => {
  if (!isEnrichmentEnabled()) return '';
  const likely = await classifyWithinTimeout(query, history);
  if (!likely) return '';
  return libraryIndexFor(userId);
};
