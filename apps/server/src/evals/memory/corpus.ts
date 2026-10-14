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

/*
 * Hand-labelled gate set. Positives are refer-backs or continuations; negatives
 * are fresh asks. The set is deliberately hard on both sides: indirect
 * refer-backs ("the same as before", "and that one?") and continuations whose
 * signal lives only in `history` test recall, while fresh asks that *look* like
 * memory probes ("what should I do about my job?") test precision. This is the
 * first of the three stages (#289) and the one that must clear a minimum-N bar
 * (≥ 30 cases, ≥ 12 per label) before any threshold is ratified.
 *
 * `note` records the labelling source (`agent-authored` vs `owner-confirmed`,
 * per the plan's OQ1) so label independence stays auditable.
 */
export const GATE_CASES: GateCase[] = [
  // Positives — explicit refer-backs to earlier decisions or work.
  {
    id: 'gate-move-decision',
    prompt: 'What did we decide about the move in the end?',
    refersBack: true,
    note: 'agent-authored: explicit refer-back to an earlier decision',
  },
  {
    id: 'gate-budget-recall',
    prompt: 'Remind me what I said about the budget.',
    refersBack: true,
    note: 'agent-authored: explicit recall of the user’s own past statement',
  },
  {
    id: 'gate-holiday-plan',
    prompt: 'Where did we leave the holiday plan?',
    refersBack: true,
    note: 'agent-authored: refer-back to shared past work',
  },
  {
    id: 'gate-remind-recommendation',
    prompt: 'What did you recommend in the end?',
    refersBack: true,
    note: 'agent-authored: refer-back to an earlier recommendation',
  },
  {
    id: 'gate-what-we-discussed',
    prompt: 'What was it we discussed about the roof?',
    refersBack: true,
    note: 'agent-authored: refer-back to an earlier discussion',
  },
  {
    id: 'gate-change-mind',
    prompt: 'Did we change our mind about the venue?',
    refersBack: true,
    note: 'agent-authored: refer-back to an earlier shared decision',
  },
  {
    id: 'gate-you-mentioned',
    prompt: 'You mentioned something about a warranty — what was it?',
    refersBack: true,
    note: 'agent-authored: refer-back to a prior assistant turn',
  },
  {
    id: 'gate-earlier-list',
    prompt: 'Add the third one to the list you made earlier.',
    refersBack: true,
    note: 'agent-authored: refer-back to work the assistant produced earlier',
  },
  {
    id: 'gate-update-that-plan',
    prompt: 'Can you update that plan with the new dates?',
    refersBack: true,
    note: 'agent-authored: refer-back to a shared artefact, then extend it',
  },
  // Positives — indirect refer-backs (no content word names the referent).
  {
    id: 'gate-same-as-before',
    prompt: 'Do the same as before.',
    refersBack: true,
    note: 'agent-authored: indirect refer-back carried entirely by deixis',
  },
  {
    id: 'gate-other-one',
    prompt: 'Actually, use the other one instead.',
    refersBack: true,
    note: 'agent-authored: indirect refer-back to a previously offered option',
  },
  {
    id: 'gate-and-that-one',
    prompt: 'And that one as well?',
    refersBack: true,
    note: 'agent-authored: elliptical continuation, referent only implied',
  },
  {
    id: 'gate-previous-version',
    prompt: 'Go back to the previous version.',
    refersBack: true,
    note: 'agent-authored: refer-back to an earlier revision',
  },
  {
    id: 'gate-one-from-yesterday',
    prompt: 'Pull up the one from yesterday.',
    refersBack: true,
    note: 'agent-authored: temporal refer-back, no content word',
  },
  // Positives — continuations whose refer-back lives only in the transcript.
  {
    id: 'gate-continuation',
    prompt: 'Can you pick that back up for me?',
    history: [
      { role: 'user', content: 'Help me plan the garden office build.' },
      { role: 'assistant', content: 'Sure — want to start with the layout or the budget?' },
    ],
    refersBack: true,
    note: 'agent-authored: continuation whose refer-back lives in the history, not the text',
  },
  {
    id: 'gate-continue-where-left',
    prompt: 'Continue where we left off.',
    history: [
      { role: 'user', content: 'I want to draft a business plan for a small coffee roastery.' },
      { role: 'assistant', content: 'Great — I have sketched the market and cost sections.' },
    ],
    refersBack: true,
    note: 'agent-authored: continuation, refer-back only in history',
  },
  {
    id: 'gate-finish-draft',
    prompt: 'Finish the draft for me.',
    history: [
      { role: 'user', content: 'Help me write a cover letter for a warehouse supervisor role.' },
      { role: 'assistant', content: 'Here is the opening paragraph — shall I carry on?' },
    ],
    refersBack: true,
    note: 'agent-authored: continuation of assistant-produced work',
  },
  {
    id: 'gate-pick-up-tax',
    prompt: 'Can you pick it up from where you stopped?',
    history: [
      { role: 'user', content: 'Walk me through filling in my self-assessment tax return.' },
      { role: 'assistant', content: 'We covered the employment section; next is expenses.' },
    ],
    refersBack: true,
    note: 'agent-authored: continuation, referent only in history',
  },
  // Negatives — fresh world-knowledge, generative, and tool asks.
  {
    id: 'gate-capital',
    prompt: 'What is the capital of Australia?',
    refersBack: false,
    note: 'agent-authored: fresh world-knowledge question',
  },
  {
    id: 'gate-poem',
    prompt: 'Write me a short poem about the sea.',
    refersBack: false,
    note: 'agent-authored: fresh generative request',
  },
  {
    id: 'gate-time',
    prompt: 'What time is it right now?',
    refersBack: false,
    note: 'agent-authored: fresh tool question',
  },
  {
    id: 'gate-photosynthesis',
    prompt: 'Explain how photosynthesis works.',
    refersBack: false,
    note: 'agent-authored: fresh explanation request',
  },
  {
    id: 'gate-fresh-why-sky',
    prompt: 'Why is the sky blue?',
    refersBack: false,
    note: 'agent-authored: fresh explanation request',
  },
  {
    id: 'gate-fresh-compound-interest',
    prompt: 'Summarise how compound interest works.',
    refersBack: false,
    note: 'agent-authored: fresh concept summary, not a document or past chat',
  },
  {
    id: 'gate-fresh-define',
    prompt: 'What does serendipity mean?',
    refersBack: false,
    note: 'agent-authored: fresh definition request',
  },
  {
    id: 'gate-fresh-news',
    prompt: 'What happened in the news today?',
    refersBack: false,
    note: 'agent-authored: fresh current-affairs question',
  },
  {
    id: 'gate-fresh-maths',
    prompt: 'What is 17 times 24?',
    refersBack: false,
    note: 'agent-authored: fresh arithmetic question',
  },
  {
    id: 'gate-fresh-python',
    prompt: 'Write a Python function that reverses a string.',
    refersBack: false,
    note: 'agent-authored: fresh coding request',
  },
  {
    id: 'gate-fresh-translate',
    prompt: 'Translate good morning into Spanish.',
    refersBack: false,
    note: 'agent-authored: fresh translation request',
  },
  // Negatives — fresh asks that superficially resemble memory probes.
  {
    id: 'gate-fresh-job-advice',
    prompt: 'What should I do about my job?',
    refersBack: false,
    note: 'agent-authored: fresh advice request, no past work referenced',
  },
  {
    id: 'gate-fresh-dinner',
    prompt: 'What should I have for dinner tonight?',
    refersBack: false,
    note: 'agent-authored: fresh suggestion request, no past work referenced',
  },
  {
    id: 'gate-fresh-trip',
    prompt: 'Help me plan a trip to Iceland.',
    refersBack: false,
    note: 'agent-authored: fresh planning request, no prior trip in play',
  },
  {
    id: 'gate-fresh-exercise',
    prompt: 'Suggest an exercise routine for a beginner.',
    refersBack: false,
    note: 'agent-authored: fresh recommendation request',
  },
  {
    id: 'gate-fresh-bakery-names',
    prompt: 'Give me some name ideas for a small bakery.',
    refersBack: false,
    note: 'agent-authored: fresh generative request',
  },
  {
    id: 'gate-fresh-recipe',
    prompt: 'Give me a recipe for sourdough bread.',
    refersBack: false,
    note: 'agent-authored: fresh generative request',
  },
  // Negative with history: history alone must not imply a refer-back.
  {
    id: 'gate-fresh-after-history',
    prompt: 'Actually, write me a short poem about the sea.',
    history: [
      { role: 'user', content: 'Help me plan the garden office build.' },
      { role: 'assistant', content: 'Sure — want to start with the layout or the budget?' },
    ],
    refersBack: false,
    note: 'agent-authored: fresh ask that follows history but refers back to nothing',
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
