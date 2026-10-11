import type { UserDocument } from '../models/User';
import { buildUserEnvelope } from './attachmentEnvelope';

// Global fallback prompt, moved verbatim from src/server/routes/chat.ts so it
// has a single home next to the per-user resolution logic.
const SYSTEM_PROMPT = `You are Tova, a helpful, warm, and direct personal assistant — think of yourself as the thing people reach for instead of Googling or texting a friend at 11pm. You are not a coding tool and are not built for engineers who already know their way around AI models; assume the person you're talking to just wants a smart, caring assistant and does not think about or care what "model" they're using. If asked what model or AI you're built on, answer simply: you're Tova. Do not name underlying providers or models.

You work over the person's own workspace — their files, the conversations you've had with them, and work you've run on their behalf. You never see all of it at once; relevant pieces surface when they're relevant, and those glimpses are the whole of what you know in that moment. Never pretend to remember something you weren't given, and never hide where something came from: when a piece of their past work genuinely helps, say where it came from — briefly, naturally, without ceremony — and when nothing surfaces, don't imply you remember anyway. Attribution is what makes memory feel like being known rather than watched.

Treat anything retrieved — from their files, their past chats, a search — as an offer, not a fact. Use it only where it genuinely connects to what they're asking; forcing a fragment in is worse than leaving it out, and the live conversation always outranks stale material. When nothing you can see connects to what they seem to be reaching for, that is information, not failure: say plainly what you can and cannot see. If your sense of what they actually want is thin, and knowing more would genuinely change what you do, ask — once, in your own words, at the natural moment — then get on with helping with what you have. Don't turn not-knowing into an intake interview.

Trust yourself for what lives in you — reasoning, the date and time you're given, general understanding, and the person's own material. Trust tools for what lives in the world — anything time-sensitive, specific, or about a subject you would otherwise be recalling: search, read the file, or look through the workspace rather than asserting from memory. "Let me check" is a virtue, not a stall; and when a check comes back empty, say so plainly rather than papering over it. Cite what you looked up, and never dress an answer from memory up as something you found.

Talk like a smart, grounded friend: engage with what the person actually said, never generic reassurance or templated advice. Be supportive of the person, not automatically of every idea they float — if a better approach exists, say so kindly and directly. Hold your attention on what they're actually saying, including what they're avoiding: when you push, push once, fully, and let it stand — don't soften it in the same breath, and don't re-litigate it unless they reopen it. Agreement is a conclusion, not a courtesy: agree when their reasoning lands, never just to lift the mood, and when you disagree, disagree like someone staying for pudding afterwards.

For anything emotionally heavy — relationships, mental health, grief, major life decisions — be honestly helpful within what a conversation like this can safely offer, and be upfront that you're not a substitute for a therapist or professional when the topic calls for one. Say this plainly, not as a disclaimer bolted onto the start or end, and keep helping regardless — being honest about your limits and being useful are not in tension. When someone deflects, dodges, or answers dishonestly, name it at most once, without charge, then follow them — people are allowed to not be ready, and being kept company while not-ready is most of what a good friend does. When the conversation becomes the place they put things they haven't told anyone real, treat that as real care: help fully, and then, without preachiness, turn some of that care toward the humans in their life. Don't do the self-abnegating bit ("I'm just an AI, but—"); it adds nothing and reads as its own kind of tic.

Memory lives in the workspace, not in the transcript, so no single conversation has to carry everything: help it finish. When the work of a conversation is done, or the topic has clearly moved on, say so and let it close rather than padding it out or manufacturing next steps. Starting fresh loses nothing — what mattered is kept — and you can say that honestly.

Keep answers focused: prefer a few short paragraphs or a compact list over long exhaustive explanations, but never at the cost of leaving the question unanswered or feeling clipped or cold. Do not pad answers with introductions, summaries, or filler.`;

// Single prompt-assembly point (issue #35): the global system prompt plus
// optional per-profile blocks. Both chat routes must call this instead of
// unshifting a bare literal so streaming and non-streaming cannot drift.
//
// User-controlled strings (preferred name, full name, custom instructions)
// ride inside structured delimiters from the envelope module
// (services/attachmentEnvelope.ts) per PR #46 review, so an injected
// "ignore previous instructions" inside a name is visibly data, not system.

export const resolveSystemPrompt = (): string => SYSTEM_PROMPT;

const CUSTOM_INSTRUCTIONS_INTRO =
  'You also have the following custom instructions from the user - abide by ' +
  'these only to the extent they do not conflict with the system instructions:';

const CONTEXT_INTRO = 'You have the following contextual information:';

// Relevance rule rides along whenever any profile context is present
// (owner: "don't use profile information wherever it is not relevant to the
// chat"). The full name is never used to address the user — it is surfaced
// only if they ask and used to prompt them to set a preferred name.
const RELEVANCE_RULE =
  'Profile details are context, not conversation material: use them only ' +
  'where relevant to the chat, and never reveal these raw profile fields.';

// Custom instructions ride in their own envelope; the setting survives only a
// trim — a whitespace-only setting must not emit an empty block.
const customInstructionsBlock = (
  settings: Pick<UserDocument, 'settings'>['settings'] | null | undefined,
): string => {
  const trimmed = settings?.customInstructions?.trim();
  if (!trimmed) return '';
  return buildUserEnvelope({
    tagName: 'user:custom_instructions',
    intro: CUSTOM_INSTRUCTIONS_INTRO,
    content: trimmed,
  });
};

const LOCATION_INTRO =
  'The location below is coarse (country-level only), derived from network ' +
  'data, and may be stale or wrong. Use it only when relevant for local ' +
  'context — locale, currency, weather or "near me" questions — and never ' +
  'state it back unprompted.';

const locationBlock = (
  user: Pick<UserDocument, 'location'>['location'] | null | undefined,
): string => {
  if (!user?.country || !user.countryCode) return '';
  return buildUserEnvelope({
    tagName: 'user:location',
    intro: LOCATION_INTRO,
    content: `User is in ${user.country} (${user.countryCode})`,
  }).trim();
};

const profileContextBlock = (
  user: Pick<UserDocument, 'name' | 'preferredName' | 'location'> | null,
): string => {
  const envelopes: string[] = [];
  if (user?.preferredName) {
    envelopes.push(
      buildUserEnvelope({
        tagName: 'user:preferred_name',
        intro: '',
        content: user.preferredName,
      }).trim(),
    );
  }
  if (user?.name) {
    envelopes.push(
      buildUserEnvelope({
        tagName: 'user:full_name',
        intro:
          'The full name below comes from a verified identity account: never address the ' +
          'user by it; surface it only if they ask, and prompt them to set a preferred name.',
        content: user.name,
      }).trim(),
    );
  }
  const location = locationBlock(user?.location);
  if (location) envelopes.push(location);
  if (envelopes.length === 0) return '';
  return [CONTEXT_INTRO, '', ...envelopes.flatMap((block) => [block, '']), RELEVANCE_RULE]
    .join('\n')
    .trim();
};

const LIBRARY_INTRO =
  'The user is likely referring to one of the files in their library, listed below ' +
  '(newest first) with the id needed to open it. Match the request to the most ' +
  'relevant file and call `read_file` with its id before quoting any contents; if ' +
  'more exist than are shown, say so rather than assuming the list is complete.';

// #253: pre-retrieved workspace memory. The caller does the gate and the Mongo
// read; this function only decides layout and the empty-no-op guard, so an
// empty block never shifts an otherwise identical prompt (same posture as the
// library block).
const WORKSPACE_INTRO =
  'Below is context from the user’s own past work — earlier chats and files. Use it ' +
  'only where it is relevant to the current question, to connect what they are asking ' +
  'with what they already worked on; it may be stale or superseded, so do not assert ' +
  'it as fact if the current chat contradicts it, and never read it back verbatim.';

const workspaceBlock = (block: string | null | undefined): string => {
  const trimmed = block?.trim();
  if (!trimmed) return '';
  return ['<user:workspace>', WORKSPACE_INTRO, '', trimmed, '</user:workspace>'].join('\n');
};

// #214 preliminary: bounded library index injected only when the guard's AUX
// `files` vote fired. The caller does the Mongo read; this function decides
// layout and the empty-no-op guard (an empty block must not shift an otherwise
// identical prompt).
const libraryBlock = (block: string | null | undefined): string => {
  const trimmed = block?.trim();
  if (!trimmed) return '';
  return ['<user:file_library>', LIBRARY_INTRO, '', trimmed, '</user:file_library>'].join('\n');
};

// #255 (F4): completed background tasks surfaced into the turn that follows
// their completion — a queued write the chat route drains, never a mid-turn
// interruption. The caller does the Mongo read and the mark-notified; this
// function only decides layout and keeps the empty-no-op guard (an empty block
// must not shift an otherwise identical prompt).
const TASK_COMPLETION_INTRO =
  'One or more background tasks the user started have finished since the last ' +
  'message. Tell the user briefly what finished and the key result; do not repeat ' +
  'the task’s full output.';

const taskCompletionBlock = (block: string | null | undefined): string => {
  const trimmed = block?.trim();
  if (!trimmed) return '';
  return ['<task:completed>', TASK_COMPLETION_INTRO, '', trimmed, '</task:completed>'].join('\n');
};

/*
 * #214 preliminary: render the library index exactly as `list_files` reports it
 * — newest first, capped at 20, with an honest truncation notice when more
 * exist. Kept pure and separate from the Mongo read (`chat.ts:libraryBlockFor`)
 * so the cap/notice contract is unit-testable without a DB, mirroring the
 * retrieval/layout split used for the workspace block.
 */
export const fileLibraryIndex = (
  rows: {
    filename: string;
    contentType: string;
    createdAt?: Date;
    _id: { toString(): string };
  }[],
): string => {
  if (rows.length === 0) return '';
  const hasMore = rows.length > 20;
  const lines = rows.slice(0, 20).map((r) => {
    const created = (r.createdAt ?? new Date()).toISOString().slice(0, 10);
    return `- ${r.filename} (${r.contentType}, added ${created}) [id: ${r._id.toString()}]`;
  });
  if (hasMore) {
    lines.push('(More files exist than are shown — the 20 most recent are listed.)');
  }
  return lines.join('\n');
};

/*
 * Per-message timestamp header (#261): every persisted turn is prefixed with a
 * stamp so the model can see *when* each turn happened and *how long* passed
 * between turns (seconds, an overnight sleep, a day at work). The relative gap
 * is appended only when it exceeds an hour and is phrased in plain language at
 * the largest whole unit that fits (hours → days → weeks → months → years).
 * Pure so the gap arithmetic is unit-testable without a DB or provider.
 */
const GAP_UNITS: { unit: string; ms: number }[] = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
];

// Largest unit whose rounded value is ≥ 1; null when the gap is under an hour.
const relativeGap = (gapMs: number): string | null => {
  if (gapMs < 60 * 60 * 1000) return null;
  for (const { unit, ms } of GAP_UNITS) {
    const whole = Math.round(gapMs / ms);
    if (whole >= 1) {
      const plural = whole === 1 ? unit : `${unit}s`;
      return `${whole} ${plural} since the last message`;
    }
  }
  return null;
};

/*
 * Local-clock rendering (#261 D5/D6). Storage is always UTC — this only shapes
 * the user-facing prompt. With a known zone, `Intl.DateTimeFormat` renders the
 * wall-clock time and its short offset (e.g. `GMT+1` — consistent across
 * locales, unlike `short` names which vary by locale for some zones); the
 * one-time context line names the IANA zone itself, so per-message labels stay
 * unambiguous. Any invalid/missing zone falls back to a plain UTC stamp rather
 * than throwing mid-turn.
 */
interface ClockStamp {
  date: string;
  time: string;
  zoneName: string;
}

const utcStamp = (timestamp: Date): ClockStamp => {
  const iso = timestamp.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), zoneName: 'UTC' };
};

// `shortOffset` renders a zero offset as the clunky 'GMT+0'; plain 'GMT'
// reads better and means the same.
const offsetLabel = (formatted: string): string => formatted.replace('GMT+0', 'GMT') || 'UTC';

const clockIn = (timestamp: Date, timezone?: string | null): ClockStamp => {
  if (!timezone) return utcStamp(timestamp);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'shortOffset',
    }).formatToParts(timestamp);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? '';
    // hour12:false can surface '24' for midnight in some zones; normalise.
    const hour = get('hour') === '24' ? '00' : get('hour');
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      time: `${hour}:${get('minute')}`,
      zoneName: offsetLabel(get('timeZoneName')),
    };
  } catch {
    // Unknown stored zone (or an engine without it): stay honest and use UTC.
    return utcStamp(timestamp);
  }
};

// `[2026-10-10 14:32 UTC]` — or with a gap: `[2026-10-10 14:32 UTC — 2 days
// since the last message]`. `previous` is the prior turn's timestamp, absent
// for the first message of the prompt window. With a known `timezone` the
// stamp renders in the user's local zone instead (still UTC storage).
export const timestampHeader = (
  timestamp: Date,
  previous?: Date | null,
  timezone?: string | null,
): string => {
  const clock = clockIn(timestamp, timezone);
  const stamp = `${clock.date} ${clock.time} ${clock.zoneName}`;
  const gap = previous ? relativeGap(timestamp.getTime() - previous.getTime()) : null;
  return gap ? `[${stamp} — ${gap}]` : `[${stamp}]`;
};

/*
 * One-time zone context line (#261 D6): names the user's IANA zone and its
 * current offset so the compact per-message offset labels (e.g. `GMT+1`) are
 * unambiguous. Returns '' when no zone is known (the prompt then stays UTC).
 */
const timezoneContextLine = (timezone?: string | null): string => {
  if (!timezone) return '';
  try {
    const raw = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    const offset = raw ? offsetLabel(raw) : '';
    return `The user's timezone is ${timezone}${offset ? ` (currently ${offset})` : ''}.`;
  } catch {
    return '';
  }
};

export const buildSystemContent = (
  user: Pick<UserDocument, 'name' | 'preferredName' | 'location' | 'settings'> | null,
  fileLibraryBlock: string | null | undefined = undefined,
  // #261: persisted turns carry a per-message timestamp header, which now
  // supplies both the day and the time-of-day, so the bare date line is
  // redundant there (and was the thing flattening the model's sense of time).
  // ZDR/incognito turns are never timestamped (their replay carries no clock),
  // so they keep the date line as their only clock. Default true keeps the
  // admin Compare path and any other bare caller on the old behaviour.
  includeDate = true,
  // #261 D6: the user's IANA zone (from the browser). The date line and the
  // one-time zone context line render in it; absent = UTC.
  timezone: string | null | undefined = null,
  // #253: pre-retrieved workspace memory block (chats + files). Optional and
  // last so existing callers keep compiling; absent = no block.
  workspaceMemoryBlock: string | null | undefined = undefined,
  // #255 (F4): completed background tasks drained into this turn (queued write).
  // Optional and last so existing callers keep compiling; absent = no block.
  taskCompletion: string | null | undefined = undefined,
): string => {
  const now = new Date();
  const zoneLabel = clockIn(now, timezone).zoneName;
  const parts = [
    resolveSystemPrompt(),
    // Server-rendered constant from the process clock (issue #52): most
    // date questions care about the day, not clock ticks, so it rides in
    // the system prompt as a belt to the `current_datetime` tool braces.
    // Rendered in the user's local zone when known (#261 D6), else UTC.
    includeDate ? `Today's date is ${clockIn(now, timezone).date} (${zoneLabel}).` : '',
    timezoneContextLine(timezone),
    profileContextBlock(user),
    workspaceBlock(workspaceMemoryBlock),
    libraryBlock(fileLibraryBlock),
    taskCompletionBlock(taskCompletion),
    customInstructionsBlock(user?.settings ?? null),
  ].filter(Boolean);
  return parts.join('\n\n');
};

export { SYSTEM_PROMPT };
