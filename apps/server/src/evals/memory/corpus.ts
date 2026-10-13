import type { GateCase, MemoryScenario } from './types';

/*
 * #289 golden corpus, modelled on the owner's real usage (issue comment
 * 2026-10-13): facts seeded in longer-lived chats, probed from fresh chats that
 * are then deleted. Every fact here is **synthetic** — same structure, no real
 * personal data — so the corpus can live in the repo.
 *
 * The scenario categories are deliberate: `direct` and `file` are the easy
 * baseline, `paraphrase` and `task` are where lexical scoring is expected to
 * struggle, and `deleted-seed` / `out-of-pool` are misses by construction that
 * document the corpus's own limits (and the headroom #293/#294 measure).
 */

/** Hand-labelled gate set. Positives read as continuations; negatives are fresh asks. */
export const GATE_CASES: GateCase[] = [
  {
    id: 'gate-move-decision',
    prompt: 'What did we decide about the move in the end?',
    refersBack: true,
    note: 'explicit refer-back to an earlier decision',
  },
  {
    id: 'gate-budget-recall',
    prompt: 'Remind me what I said about the budget.',
    refersBack: true,
    note: 'explicit recall of the user’s own past statement',
  },
  {
    id: 'gate-holiday-plan',
    prompt: 'Where did we leave the holiday plan?',
    refersBack: true,
    note: 'refer-back to shared past work',
  },
  {
    id: 'gate-continuation',
    prompt: 'Can you pick that back up for me?',
    history: [
      { role: 'user', content: 'Help me plan the garden office build.' },
      { role: 'assistant', content: 'Sure — want to start with the layout or the budget?' },
    ],
    refersBack: true,
    note: 'continuation whose refer-back lives in the history, not the text',
  },
  {
    id: 'gate-capital',
    prompt: 'What is the capital of Australia?',
    refersBack: false,
    note: 'fresh world-knowledge question',
  },
  {
    id: 'gate-poem',
    prompt: 'Write me a short poem about the sea.',
    refersBack: false,
    note: 'fresh generative request',
  },
  {
    id: 'gate-time',
    prompt: 'What time is it right now?',
    refersBack: false,
    note: 'fresh tool question',
  },
  {
    id: 'gate-photosynthesis',
    prompt: 'Explain how photosynthesis works.',
    refersBack: false,
    note: 'fresh explanation request',
  },
];

/** Retrieval + helpfulness scenarios. One seed world each, isolated by reseeding. */
export const MEMORY_SCENARIOS: MemoryScenario[] = [
  {
    id: 'retrieval-direct-partner-job',
    description: 'Direct query shares the content word "partner" with the seed.',
    category: 'direct',
    seeds: [
      {
        id: 'seed-partner-job',
        kind: 'chat',
        title: 'Work chat',
        text: 'My partner is a doctor — a consultant paediatrician — and she is looking for work outside the NHS.',
        at: '2026-09-20T10:00:00.000Z',
      },
    ],
    query: 'What does my partner do for work?',
    expectedSliceId: 'seed-partner-job',
    expectSurfaced: true,
    expectedFact: 'paediatrician',
  },
  {
    id: 'retrieval-paraphrase-partner',
    description: 'Paraphrase query shares no content word with the seed.',
    category: 'paraphrase',
    seeds: [
      {
        id: 'seed-partner-paediatrician',
        kind: 'chat',
        title: 'Fertility chat',
        text: 'She is a doctor, a community paediatrician, so she knows the fertility statistics better than most.',
        at: '2026-09-20T10:00:00.000Z',
      },
    ],
    query: 'What do you know about my partner and her job?',
    expectedSliceId: 'seed-partner-paediatrician',
    expectSurfaced: true,
    expectedFact: 'paediatrician',
  },
  {
    id: 'retrieval-file-lease-pets',
    description: 'Fact lives in a file slice.',
    category: 'file',
    seeds: [
      {
        id: 'seed-lease',
        kind: 'file',
        title: 'tenancy-agreement.md',
        text: 'Pets clause: the tenant may keep one cat and one dog with the landlord’s written consent.',
        at: '2026-09-01T10:00:00.000Z',
      },
    ],
    query: 'What did the lease say about pets?',
    expectedSliceId: 'seed-lease',
    expectSurfaced: true,
    expectedFact: 'one cat',
  },
  {
    id: 'retrieval-task-budget',
    description: 'Fact lives in a task transcript slice (#298).',
    category: 'task',
    seeds: [
      {
        id: 'seed-task-budget',
        kind: 'task',
        title: 'Work out the moving budget',
        text: 'The moving budget comes to twelve thousand pounds once removals and storage are included.',
        at: '2026-09-25T10:00:00.000Z',
      },
    ],
    query: 'What was the moving budget we worked out?',
    expectedSliceId: 'seed-task-budget',
    expectSurfaced: true,
    expectedFact: 'twelve thousand',
  },
  {
    id: 'retrieval-deleted-seed',
    description: 'Seed sits in a soft-deleted chat: excluded by construction.',
    category: 'deleted-seed',
    seeds: [
      {
        id: 'seed-deleted-key',
        kind: 'chat',
        title: 'Deleted chat',
        text: 'The spare key is under the third plant pot by the back door.',
        at: '2026-09-10T10:00:00.000Z',
        deleted: true,
      },
    ],
    query: 'Where did I say the spare key is?',
    expectedSliceId: 'seed-deleted-key',
    expectSurfaced: false,
    expectedFact: 'third plant pot',
  },
  {
    id: 'retrieval-out-of-pool',
    description: 'Seed buried beyond MESSAGE_POOL by newer messages: unreachable today.',
    category: 'out-of-pool',
    seeds: [
      {
        id: 'seed-old-policy',
        kind: 'chat',
        title: 'Old chat',
        text: 'My travel insurance policy number is AX-4471.',
        at: '2026-09-05T10:00:00.000Z',
      },
    ],
    query: 'What is my travel insurance policy number?',
    expectedSliceId: 'seed-old-policy',
    expectSurfaced: false,
    expectedFact: 'AX-4471',
    poolFill: 210,
  },
];
