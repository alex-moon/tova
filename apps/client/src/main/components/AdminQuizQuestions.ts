// Quiz bank for #419: one question per pipeline "idea", sourced from
// apps/server/src/main. Correct option is at `answer`; the view shuffles
// option order at render. Player-facing rules: copy references modules and
// mechanisms only (never tickets/tests/process), the rationale lives in
// `explain` — never in the option text — and options stay length-balanced so
// the answer is not guessable by size (pinned by a bank test).
// @see #419

export type QuizQuestion = {
  id: string;
  category: string;
  q: string;
  options: string[];
  answer: number;
  explain: string;
};

export const QUIZ_CATEGORIES = [
  'Routing & racing',
  'Task runtime',
  'Workspace memory',
  'Aux model & honesty guard',
  'System prompt',
  'Metrics & privacy',
  'Redaction & observability',
  'Files & storage',
  'Connectors',
  'Bootstrap & background',
] as const;

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  // ── Routing & racing ──────────────────────────────────────────────
  {
    id: 'r01',
    category: 'Routing & racing',
    q: 'What decides which model serves a chat turn?',
    options: [
      'The CHAT_MODEL env var',
      'A Mongo roster ranked by TTFT × price',
      'A prompt-complexity classifier',
      'The TASK_MODEL env var',
    ],
    answer: 0,
    explain:
      'modelDefaults.ts pins models per function from env — CHAT_MODEL defaults to zai-org/GLM-5.3-Flash. The roster and the complexity classifier are retired mechanisms.',
  },
  {
    id: 'r02',
    category: 'Routing & racing',
    q: 'Why do tasks always ride DeepInfra instead of racing providers?',
    options: [
      'The task model is stale on Fireworks',
      'Fireworks lacks tool calling',
      'DeepInfra is contractually exclusive',
      'Fireworks is stream-only',
    ],
    answer: 0,
    explain:
      'modelDefaults.ts: "DS4.1F is fireworks-stale" — unmaintained on Fireworks and the unversioned id prices higher there, so tasks pin DeepInfra.',
  },
  {
    id: 'r03',
    category: 'Routing & racing',
    q: 'How does the hedged chat race in chatRace.ts pick a winner?',
    options: [
      'First token wins; losers aborted',
      'Providers tried in sequence',
      'Full answers scored, best kept',
      "Weighted pick by last turn's TTFT",
    ],
    answer: 0,
    explain:
      'chatRace.ts fires every known backend of CHAT_MODEL concurrently; the first to yield a token/resolution wins and the losers are aborted.',
  },
  {
    id: 'r04',
    category: 'Routing & racing',
    q: 'Why must a losing completion race attempt be aborted, not left to finish?',
    options: [
      'It re-runs tools and doubles spend',
      'It corrupts the TTFT statistics',
      'Mastra caps open completions',
      'It overwrites the persisted message',
    ],
    answer: 0,
    explain:
      'A background loser runs the whole agent loop to resolution — a second delegate_task/generate_file and double token spend — so each attempt gets an abort controller killed on the win.',
  },
  {
    id: 'r05',
    category: 'Routing & racing',
    q: 'CHAT_MODEL is set to a model id Tova does not know. What happens?',
    options: [
      'It rides DeepInfra alone',
      'Chat fails a config check',
      'It falls back to the default',
      'It races the display id',
    ],
    answer: 0,
    explain:
      'chatBackends(): only known defaults have a (provider → id) map; an unknown override rides DeepInfra alone, verbatim.',
  },
  {
    id: 'r06',
    category: 'Routing & racing',
    q: 'When does the SSE stream emit its `meta` event?',
    options: [
      'After the race resolves',
      'Before the race starts',
      'With the first delta',
      'Only on errors',
    ],
    answer: 0,
    explain:
      'The chat route sends meta after the race resolves and before any delta — it names the provider that actually serves the turn.',
  },
  {
    id: 'r07',
    category: 'Routing & racing',
    q: 'Which of these is NOT part of the current routing stack?',
    options: [
      'Provider cool-offs',
      'Hedged provider racing',
      'The static price table',
      'Env-pinned model ids',
    ],
    answer: 0,
    explain:
      'Cool-offs died with the roster era — a failing backend just loses the race or fails the turn. TTFT survives as diagnostics only.',
  },
  {
    id: 'r08',
    category: 'Routing & racing',
    q: 'How are max_tokens for a chat turn sized?',
    options: [
      'From a static context table',
      "From the winner's own report",
      'A fixed 4096 output cap',
      'Proportional to prompt length',
    ],
    answer: 0,
    explain:
      'MODEL_CONTEXT_LENGTHS (both defaults 1048576) is static so outputTokensFor never needs a live lookup — sizing against a post-race winner would mismatch the pre-race pick.',
  },
  {
    id: 'r09',
    category: 'Routing & racing',
    q: 'A trace carries a pre-retirement unsuffixed DeepSeek id. The cost estimate…',
    options: [
      'Prices it normally',
      'Estimates as null',
      'Estimates as zero',
      'Throws and skips it',
    ],
    answer: 0,
    explain:
      'buildPriceIndex covers every key of MODEL_PRICES, including pre-retirement ids, so historical traces keep cost estimates; genuinely unknown ids estimate as null.',
  },
  {
    id: 'r10',
    category: 'Routing & racing',
    q: 'Every backend of the chat model fails. The race surfaces…',
    options: [
      'The most actionable error',
      'A silent empty reply',
      'An automatic full retry',
      'A 503 all-disabled message',
    ],
    answer: 0,
    explain:
      'The all-fail surface prefers an actionable provider error over a client abort (the isClientAbort check); there is no roster to fall through to.',
  },
  {
    id: 'r11',
    category: 'Routing & racing',
    q: 'What role does TTFT play in routing?',
    options: [
      'Diagnostics only',
      'It weights provider picks',
      'It decides the winner',
      'It is not measured',
    ],
    answer: 0,
    explain:
      'TTFT is not persisted as a routing input; it remains a step/race diagnostic in logs and traces.',
  },
  {
    id: 'r12',
    category: 'Routing & racing',
    q: 'Where does the model pricing table live?',
    options: [
      'A static table in modelDefaults.ts',
      'A Mongo pricing collection',
      "The providers' live price APIs",
      'The Mastra connectors',
    ],
    answer: 0,
    explain:
      'MODEL_PRICES: static (model, provider) → USD/1M; cached pricing deliberately not modelled, unknown rows estimate as null.',
  },

  // ── Task runtime ──────────────────────────────────────────────────
  {
    id: 't01',
    category: 'Task runtime',
    q: 'What does passing taskMode: true actually do?',
    options: [
      'Selects the lean task agent',
      'Forces tool_choice required',
      'Pins DeepInfra, no streaming',
      'Grants an extra budget',
    ],
    answer: 0,
    explain:
      "It forces nothing — the forced toolChoice: 'required' made the text-only settle unreachable, so the option was reduced to selecting the lean toolset + task instructions in mastraService.",
  },
  {
    id: 't02',
    category: 'Task runtime',
    q: 'What is the task processor\'s settle ("done") condition?',
    options: [
      'Text with no tool calls',
      'Any step with no tools',
      'A DONE token from the model',
      'The step budget reached',
    ],
    answer: 0,
    explain:
      "taskProcessor: text !== '' && tools.length === 0 — a text-only step is the final answer.",
  },
  {
    id: 't03',
    category: 'Task runtime',
    q: 'Under a strictly honored tool_choice "required", a task…',
    options: [
      'Churns tool calls to the budget',
      'Settles instantly, no work',
      'Ignores the flag entirely',
      'Crashes the connector',
    ],
    answer: 0,
    explain:
      "done (text, no tools) is unreachable under strict required. DeepInfra honors the flag loosely — the other failure mode is an instant bogus 'done' on an intent-only answer.",
  },
  {
    id: 't04',
    category: 'Task runtime',
    q: 'Why is delegate_task removed from the task toolset?',
    options: [
      'A task has no sessionId',
      'It would recurse forever',
      'Mastra forbids nesting',
      'It doubles the token spend',
    ],
    answer: 0,
    explain:
      'delegate_task delegates to a chat session; from a task there is no sessionId, so it can never succeed — the lean toolset drops it.',
  },
  {
    id: 't05',
    category: 'Task runtime',
    q: 'The default task step budget, and the real runaway fuse?',
    options: [
      '150 steps; the $5 cost cap',
      '25 steps; the step count',
      '1500 steps; a 1-hour TTL',
      'Unlimited; cost only',
    ],
    answer: 0,
    explain:
      'config.task: TASK_MAX_STEPS defaults to 150 (deep investigations paused at 25 far too early); spentUsd >= TASK_MAX_COST_USD (default $5) pauses the task.',
  },
  {
    id: 't06',
    category: 'Task runtime',
    q: 'Steering or resuming a paused task does what to the step budget?',
    options: [
      'Grants a fresh increment',
      'Leaves it exhausted',
      'Resets the steps used',
      'Refuses at half spent',
    ],
    answer: 0,
    explain:
      "taskService $inc's budget.maxSteps by config.task.maxSteps on steer/resume — resuming at the cap no longer re-pauses instantly.",
  },
  {
    id: 't07',
    category: 'Task runtime',
    q: 'How does the heartbeat keep live tasks out of the stale-requeue sweep?',
    options: [
      '60s touch vs a 5-min cutoff',
      'Provider pings every 5 min',
      'Lease re-claim each tick',
      'A heartbeat row per step',
    ],
    answer: 0,
    explain:
      "taskProcessor touches the task's updatedAt every TASK_HEARTBEAT_MS (60s) while a step runs; the sweep only reclaims tasks idle over 5 minutes.",
  },
  {
    id: 't08',
    category: 'Task runtime',
    q: 'requeueStaleTasks on a stale task already at MAX_TASK_ATTEMPTS?',
    options: [
      'Fails it with a lastError',
      'Requeues one final time',
      'Pauses it for review',
      'Deletes it and its stream',
    ],
    answer: 0,
    explain:
      'The stale path charges attempts — other stale requeues $inc attempts by 1; a poison task can no longer restart forever.',
  },
  {
    id: 't09',
    category: 'Task runtime',
    q: 'The leaseToken fence protects against…',
    options: [
      'A frozen processor double-run',
      'Two users steering one task',
      'Replica-lag reads',
      'Expired PATs mid-step',
    ],
    answer: 0,
    explain:
      "Laptop sleep: the sweep requeues, a twin processor claims, the woken original double-runs. Claims stamp a leaseToken and every processor read/write is scoped on it — the stale twin's reads miss and it exits.",
  },
  {
    id: 't10',
    category: 'Task runtime',
    q: 'How does cancellation stop the in-flight task step?',
    options: [
      'An abort signal per attempt',
      'A flag checked between tokens',
      'A socket-level kill',
      'It takes effect next step',
    ],
    answer: 0,
    explain:
      'The abort registry is a Set per task (a second registration used to orphan the first); the signal threads into CompletionOptions.abortSignal via the Mastra connector.',
  },
  {
    id: 't11',
    category: 'Task runtime',
    q: 'Why does the processor re-verify ownership after registering the abort handler?',
    options: [
      'Cancel can land before step start',
      'Mongo reorders concurrent writes',
      'Leases expire every poll',
      'Instructions can change',
    ],
    answer: 0,
    explain:
      'Without the re-check (_id + lease + running), a cancel landing between the loop-top read and the registration ran a full billed step on a cancelled task.',
  },
  {
    id: 't12',
    category: 'Task runtime',
    q: 'How does assembleTaskHistory window the replayed event stream?',
    options: [
      'Anchor + newest, bounded middle',
      'Oldest-first, 2000 chars',
      'The last 5 events only',
      'The entire stream, always',
    ],
    answer: 0,
    explain:
      "The newest message always rides (truncated when it alone busts the budget), the instruction anchor always rides, the middle fills newest-first under 200 messages / 400k chars — task-local constants mirroring chat's window.",
  },
  {
    id: 't13',
    category: 'Task runtime',
    q: 'The replay bug that made tasks stop after one step?',
    options: [
      'Content OR tool replay, never both',
      'Budget spent in one step',
      'Race aborted wrong provider',
      'Results clipped to 2000 chars',
    ],
    answer: 0,
    explain:
      "An assistant event replayed event.content or its tool replay, never both — narration erased the tool exchange from the next step's context. The fix joins both (renderToolReplay lines included).",
  },
  {
    id: 't14',
    category: 'Task runtime',
    q: 'steerTask re-checks the task status after appending the steering turn. Why?',
    options: [
      'The append can race a settle',
      'To refresh the heartbeat',
      'Mongo demands a re-read',
      'To detect an expired lease',
    ],
    answer: 0,
    explain:
      'No cross-collection transactions on standalone dev Mongo, so the TOCTOU race closes by post-append refusal — the API never claims a turn was queued onto a dead stream.',
  },
  {
    id: 't15',
    category: 'Task runtime',
    q: 'How many pending task completions drain onto a single chat turn?',
    options: [
      'Up to 5, oldest first',
      'All of them, newest first',
      'Exactly one',
      'None without a resume',
    ],
    answer: 0,
    explain:
      'pendingCompletionsFor takes a limit (default 5, oldest first) so a backlog cannot flood one turn.',
  },
  {
    id: 't16',
    category: 'Task runtime',
    q: "A step's cost lands in budget.spentUsd how?",
    options: [
      'From outcome token usage',
      'A flat per-step fee',
      'A prompt-size estimate',
      'Recomputed from history',
    ],
    answer: 0,
    explain:
      "estimateCostUsd + priceRowsForModel on the outcome's usage, $inc'd in the same header write as stepCount; absent usage or an unpriced model increments nothing — unknown cost is never faked.",
  },
  {
    id: 't17',
    category: 'Task runtime',
    q: 'enqueueTask seeds a placeholder event for an absent instruction. Its compensation guards what?',
    options: [
      'A failed seed stranding a header',
      'Whitespace-only instructions',
      'Same-named duplicate tasks',
      'A missing provider key',
    ],
    answer: 0,
    explain:
      'If the seed write fails, the header is deleted — but only while the task is still queued, so a claim that slipped in during the window is never stranded headerless.',
  },
  {
    id: 't18',
    category: 'Task runtime',
    q: 'taskSequencer clips step text at 2000 chars with .slice, splitting astral surrogates. The known consequence?',
    options: [
      'Explains the CJK strays only',
      'Root cause of both classes',
      'Disproven — it never splits',
      'Only affects task titles',
    ],
    answer: 0,
    explain:
      'The clip split is real for the CJK stray class; the English near-miss class (valid ASCII both sides, e.g. "arguably"→"argumentatively") needs a different cause entirely.',
  },

  // ── Workspace memory ─────────────────────────────────────────────
  {
    id: 'm01',
    category: 'Workspace memory',
    q: 'When does workspace-memory retrieval run?',
    options: [
      'Every non-ZDR text turn',
      'On an aux intent vote',
      'When the user types @memory',
      'First turn of a session',
    ],
    answer: 0,
    explain:
      "There is no intent gate — the aux vote's false-negative class killed it; rerank-and-cut supplies the relevance bar (workspaceRetrievalService). Image turns and ZDR stay off.",
  },
  {
    id: 'm02',
    category: 'Workspace memory',
    q: "The retrieval pipeline's stage order?",
    options: [
      'Fuse BM25 + vector, then rerank-cut',
      'Vector, then BM25, then dedupe',
      'Rerank first, then fuse both',
      'BM25 alone, no fusion stage',
    ],
    answer: 0,
    explain:
      'Retrieve liberally (fused BM25 ∪ Atlas vector candidates, capped), then grade absolutely and cut — including cutting everything.',
  },
  {
    id: 'm03',
    category: 'Workspace memory',
    q: 'Which reranker does the cut stage use?',
    options: [
      'Qwen3-Reranker-0.6B',
      'bge-reranker-v2-m3',
      'A local cross-encoder',
      "OpenAI's rerank API",
    ],
    answer: 0,
    explain:
      'DeepInfra no longer serves bge-reranker-v2-m3 (404); the Qwen3 family shares the {queries, documents} → {scores} contract, and a calibration probe picked 0.6B for separation, price, latency.',
  },
  {
    id: 'm04',
    category: 'Workspace memory',
    q: 'Why is RERANK_CUT = 0.005 corpus-independent?',
    options: [
      'Reranker scores are probabilities',
      'Scaled by average doc length',
      'Adapted to score history',
      'A percentile of the set',
    ],
    answer: 0,
    explain:
      "Calibration: relevant ≈ 0.98+, irrelevant ≤ 0.0009, bare-deixis max 0.0036 — an absolute bar in the decade gap, unlike BM25's corpus-relative scores.",
  },
  {
    id: 'm05',
    category: 'Workspace memory',
    q: 'The rerank cut removes every candidate. The behaviour?',
    options: [
      'No memory block renders',
      'Fused ranking returns uncut',
      'The turn errors',
      "BM25's top hit injects",
    ],
    answer: 0,
    explain:
      'Empty after cut → [] → renderBlock renders no block — the clean refusal path. "And that one as well?" grades far below the bar and stays quiet.',
  },
  {
    id: 'm06',
    category: 'Workspace memory',
    q: 'The reranker service returns null (provider down, no key, timeout). Then?',
    options: [
      'Fused ranking returns uncut',
      'Retrieval skips the turn',
      'The turn fails loudly',
      'BM25 alone is used',
    ],
    answer: 0,
    explain:
      'rerankerService never throws — every failure degrades to null, and rankWorkspaceSlices returns the un-cut fused order (exactly the pre-rerank behaviour).',
  },
  {
    id: 'm07',
    category: 'Workspace memory',
    q: 'The caps on the rerank input?',
    options: [
      '24 candidates, 2000 chars/doc',
      '12 candidates, 500 chars',
      'Unlimited candidates',
      '24 candidates, full text',
    ],
    answer: 0,
    explain:
      'RERANK_MAX_CANDIDATES 24 (RRF order) and RERANK_DOC_CHARS 2000 (doc text is title\\ncontent); returned slices keep full text, candidateCount reports the graded count.',
  },
  {
    id: 'm08',
    category: 'Workspace memory',
    q: 'Why is the chat-message corpus read capped at the newest 500?',
    options: [
      'O(1) per turn, not O(history)',
      'Atlas rejects larger reads',
      'Older messages soft-delete',
      'It bounds the reranker input',
    ],
    answer: 0,
    explain:
      'CHAT_POOL: collectWorkspaceSlices reads .sort({timestamp:-1}).limit(500) — generous for retrieval quality, bounded so corpus size never maps onto per-turn cost.',
  },
  {
    id: 'm09',
    category: 'Workspace memory',
    q: 'VECTOR_NUM_CANDIDATE_MULTIPLIER does what?',
    options: [
      'Sets numCandidates to limit × 4',
      'Switches the distance metric',
      'Quantizes vectors to int8',
      'Races BM25 for recall',
    ],
    answer: 0,
    explain:
      'numCandidates used to equal limit — zero exploration over the result window. The ×4 multiplier gives the Atlas ANN query real headroom.',
  },
  {
    id: 'm10',
    category: 'Workspace memory',
    q: 'The title-fold hash-parity bug between ingest and backfill?',
    options: [
      'Backfill folded every kind',
      'Base64 vs raw vector storage',
      'Model id missing from hash',
      'Case-mismatched filenames',
    ],
    answer: 0,
    explain:
      'Ingest folded titles only for kind: file; backfill folded every kind — chat/task hashes mismatched, so every backfill re-embedded the whole corpus. Fix: fold only for file, in the planner.',
  },
  {
    id: 'm11',
    category: 'Workspace memory',
    q: 'Factory-reset purge vs in-flight embedding writes leaking vectors?',
    options: [
      'A drained in-flight registry',
      'Synchronous embeds during purge',
      'Per-user encryption keys',
      'Whole-collection deletion',
    ],
    answer: 0,
    explain:
      'workspaceEmbeddingIngest tracks in-flight embeds per user; drainUserEmbeddings(uid) runs before the Mongo sweep and once more after. A genuinely concurrent post-reset turn is new content, not leaked data.',
  },
  {
    id: 'm12',
    category: 'Workspace memory',
    q: 'A dim change re-embeds via a query filter, not a hash change. Why?',
    options: [
      'Avoids a full re-embed on deploy',
      'The hash must stay stable',
      "Mongo can't index hashed dims",
      'It does fold into the hash',
    ],
    answer: 0,
    explain:
      'Folding dim into the hash would change every digest — a one-time full re-embed of every corpus. Filtering dim at the skip lookup re-embeds only stale rows; the Atlas index itself needs a manual recreate.',
  },
  {
    id: 'm13',
    category: 'Workspace memory',
    q: 'Which kinds of content become workspace slices?',
    options: [
      'Chat, file, and task',
      'Chat messages only',
      'Files and uploads only',
      'Chat and fetched pages',
    ],
    answer: 0,
    explain:
      "kind: 'chat' | 'file' | 'task' — past chats, file contents, and task transcripts. fetch_url pages enter as kind: file (system-side assets).",
  },
  {
    id: 'm14',
    category: 'Workspace memory',
    q: 'The workspace embedding model and provider?',
    options: [
      'bge-base-en-v1.5 on DeepInfra',
      'text-embedding-3-small on OpenAI',
      'bge-m3 on Fireworks',
      'A local transformer build',
    ],
    answer: 0,
    explain:
      'config.embeddings defaults to BAAI/bge-base-en-v1.5; embeddingService is a thin DeepInfra fetch client with write-side dim validation.',
  },
  {
    id: 'm15',
    category: 'Workspace memory',
    q: 'The three memory-gate labels in workspace traces?',
    options: ['off, yes, no', 'yes, no, unknown', 'hit, miss, partial', 'on, off, degraded'],
    answer: 0,
    explain:
      'workspaceGateFrom re-derives from the retrieval outcome: off (image turn / kill switch), yes (block non-empty), no (empty after retrieval or cut).',
  },

  // ── Aux model & honesty guard ────────────────────────────────────
  {
    id: 'a01',
    category: 'Aux model & honesty guard',
    q: 'Which model serves the auxiliary calls?',
    options: [
      'gpt-oss-20b on Groq',
      'GLM-5.3-Flash on DeepInfra',
      'gpt-4o-mini on OpenAI',
      'Whatever CHAT_MODEL is',
    ],
    answer: 0,
    explain:
      'One cheap fixed aux source (AUX_MODEL/AUX_PROVIDER, default openai/gpt-oss-20b on groq) feeds all side calls, independent of the chat/task models.',
  },
  {
    id: 'a02',
    category: 'Aux model & honesty guard',
    q: 'Which of these is NOT an auxiliary LLM call site?',
    options: ['Entity extraction', 'Chat title', 'Follow-up suggestions', 'Metric classification'],
    answer: 0,
    explain:
      'The five aux sites: titleService, subtitleService, followupService, metricsService, honestyGuardService. An entity-graph extractor existed once and was removed outright.',
  },
  {
    id: 'a03',
    category: 'Aux model & honesty guard',
    q: 'Why did the guard and metrics classifiers get max_tokens raised to 1024?',
    options: [
      'Hidden reasoning ate the budget',
      'Long prompts truncated JSON',
      'Groq requires a 1024 minimum',
      'To fit the full history',
    ],
    answer: 0,
    explain:
      'gpt-oss-20b is a reasoning model: budgets of 120/100 were spent on hidden chain-of-thought before any answer. 1024 is a safety bound, not a cost driver; title/subtitle stay at 512.',
  },
  {
    id: 'a04',
    category: 'Aux model & honesty guard',
    q: 'An aux classifier returns empty or length-truncated output. Then?',
    options: [
      'Warn once, leave unassessed',
      'Record a fallback clean',
      'Retry the whole turn',
      'Delete the message',
    ],
    answer: 0,
    explain:
      'A fallback-to-clean verdict was worse than no verdict — garbage returns null with a single-line warn; the message stays unassessed.',
  },
  {
    id: 'a05',
    category: 'Aux model & honesty guard',
    q: "The honesty guard's aux call is deterministically skipped when…",
    options: [
      'Any tool executed',
      'The message is very short',
      'ZDR is enabled',
      'The model is cooling off',
    ],
    answer: 0,
    explain:
      'The flag rule ("claims tool use, zero executed tools") is unreachable on a turn that ran tools — cheaper than asking every turn. (ZDR also skips it, but that is a persistence consequence.)',
  },
  {
    id: 'a06',
    category: 'Aux model & honesty guard',
    q: 'An ABSENT honesty subdoc on a message means…',
    options: ['Not assessed', 'Verified clean', 'Flagged but muted', 'Guard disabled'],
    answer: 0,
    explain:
      'The subdoc is {flagged, reason, checkedAt}; absence means the aux call or parse failed — deliberately distinct from a clean verdict (no synthetic false).',
  },
  {
    id: 'a07',
    category: 'Aux model & honesty guard',
    q: 'The next-turn honesty correction reaches the model via…',
    options: [
      'A bracketed prompt note',
      'An injected system message',
      'A rewritten assistant message',
      'A dismissible client banner',
    ],
    answer: 0,
    explain:
      'Prompt assembly appends a corrective note to the current user turn when the newest assistant message is flagged — never persisted, never shown (same mechanism as the provenance line).',
  },
  {
    id: 'a08',
    category: 'Aux model & honesty guard',
    q: 'Why is the honesty auto-retry a server-side restart, not a client auto-click?',
    options: [
      'A client retry duplicates the turn',
      'The client cannot reach the aux model',
      'Server retries are free',
      'Verdicts need persistence',
    ],
    answer: 0,
    explain:
      'The client\'s "Retry for real" resends the user message as a new persisted turn — a duplicate bubble, and the flagged reply persists forever. Restarting inside the stream request persists nothing about the dishonest attempt.',
  },
  {
    id: 'a09',
    category: 'Aux model & honesty guard',
    q: 'The honesty retry is exhausted (second attempt also flagged). Then?',
    options: [
      'Flag + badge + manual retry',
      'Five retries, then give up',
      'Persist the reply as clean',
      'Cancel the turn',
    ],
    answer: 0,
    explain:
      'Bounded to one retry; the exhausted path restores the #371 behaviour — persist the flag, send the post-done honesty frame, keep the badge and manual button as last resort.',
  },
  {
    id: 'a10',
    category: 'Aux model & honesty guard',
    q: 'The latency cost the honesty auto-retry knowingly accepted?',
    options: [
      'A transient flash before wipe',
      'A 10s delay before streaming',
      'Double the token spend',
      'A blocked first streamed delta',
    ],
    answer: 0,
    explain:
      "Attempt 1's dishonest text streams live before being wiped — buffering every turn would kill live streaming. Deltas are fully out by the time the guard runs.",
  },
  {
    id: 'a11',
    category: 'Aux model & honesty guard',
    q: 'The ~1s guard call lands where on tool-free streaming turns?',
    options: [
      'Between stream end and done',
      'Before the first delta',
      'Parallel with the deltas',
      'On the next user turn',
    ],
    answer: 0,
    explain:
      "done finalizes the client's bubble and only fires after the final attempt passes — the guard is tail latency on an already-rendered reply.",
  },
  {
    id: 'a12',
    category: 'Aux model & honesty guard',
    q: "A flagged reply's badge never appeared without a refresh. The bug?",
    options: [
      'The frame named a renamed bubble',
      'Badge CSS behind a media query',
      'The frame closed the stream',
      'Redaction dropped the frame',
    ],
    answer: 0,
    explain:
      'The post-done honesty frame targeted the streamId bubble, but done had already renamed it to the persisted id — a silent no-op until refresh. The handler now matches the adopted id.',
  },

  // ── System prompt ────────────────────────────────────────────────
  {
    id: 's01',
    category: 'System prompt',
    q: "Asked which model it's built on, Tova answers…",
    options: [
      "Simply: 'I'm Tova'",
      'The serving model name',
      'It declines entirely',
      'A fine-tuned GLM',
    ],
    answer: 0,
    explain:
      'SYSTEM_PROMPT in promptAssembly.ts: "If asked what model or AI you\'re built on, answer simply: you\'re Tova. Do not name underlying providers or models."',
  },
  {
    id: 's02',
    category: 'System prompt',
    q: 'The anti-fabrication rule forbids…',
    options: [
      'Claiming unexecuted work',
      'Uncited file quotes',
      'Present-tense future plans',
      'Naming hidden tools',
    ],
    answer: 0,
    explain:
      'Never state that you read, searched, fetched, checked, or ran anything unless that call actually executed in this conversation — describing work you did not do is fabrication.',
  },
  {
    id: 's03',
    category: 'System prompt',
    q: 'timestampHeader renders what on each history message?',
    options: [
      'A clock stamp, plus a gap line',
      'A Unix epoch in brackets',
      'The message index',
      'Nothing — client-side only',
    ],
    answer: 0,
    explain:
      '[date time zone], optionally "N <unit>s since the last message" in the largest unit ≥ 1; under an hour there is no gap line. ZDR turns keep the bare date line as their only clock.',
  },
  {
    id: 's04',
    category: 'System prompt',
    q: "The user's stored IANA timezone is unknown to Intl. The clock…",
    options: [
      'Falls back to UTC',
      'Throws, failing the turn',
      'Uses the server zone',
      'Omits the timestamp',
    ],
    answer: 0,
    explain:
      'clockIn catches the failure and renders the UTC stamp — an unknown stored zone never breaks assembly.',
  },
  {
    id: 's05',
    category: 'System prompt',
    q: 'User-controlled strings enter the system prompt…',
    options: [
      'In escaped envelope delimiters',
      'As plain assistant-voice text',
      'Base64-encoded to block injection',
      'As a later user message',
    ],
    answer: 0,
    explain:
      'buildUserEnvelope + escapeEnvelopeBreakers (content/attachmentEnvelope): user strings ride inside envelopes, visibly data, with forged closers escaped so a block cannot be closed and forged mid-text.',
  },
  {
    id: 's06',
    category: 'System prompt',
    q: 'The workspace-memory envelope intro tells the model the block…',
    options: [
      'May be stale — never recite it',
      'Is ground truth for past events',
      'Must open every reply',
      'Is confidential — never referenced',
    ],
    answer: 0,
    explain:
      'Use it only where relevant to connect the question with past work; it may be stale or superseded, so do not assert it as fact if the current chat contradicts it, and never read it back verbatim.',
  },
  {
    id: 's07',
    category: 'System prompt',
    q: 'The task:completed block tells the model to report finished tasks…',
    options: [
      'Briefly, key result only',
      'With the full transcript',
      'Only when the user asks',
      'As a file reference',
    ],
    answer: 0,
    explain:
      "TASK_COMPLETION_INTRO: tell the user briefly what finished and the key result; do not repeat the task's full output.",
  },
  {
    id: 's08',
    category: 'System prompt',
    q: 'The verified-account full name in the system prompt is governed by…',
    options: [
      'Never address the user by it',
      'Always use it — it is verified',
      'First message of a session only',
      'Audit-only, hidden from the model',
    ],
    answer: 0,
    explain:
      'profileContextBlock: the full name comes from a verified identity account — surface it only if the user asks, and prompt them to set a preferred name (the addressable one).',
  },

  // ── Metrics & privacy ────────────────────────────────────────────
  {
    id: 'v01',
    category: 'Metrics & privacy',
    q: 'ZDR is enabled. What does a chat turn persist?',
    options: [
      'Nothing is persisted',
      'Messages, stripped of ids',
      'Everything, encrypted',
      'A daily-purged zdr collection',
    ],
    answer: 0,
    explain:
      'Session-less: no Session or Message rows, no title or classification writes — continuity rides a client-replayed capped history payload.',
  },
  {
    id: 'v02',
    category: 'Metrics & privacy',
    q: 'A request carries a sessionId while the sender has ZDR on. The server…',
    options: [
      'Rejects it with 409',
      'Drops the sessionId',
      'Persists as usual',
      'Marks the session ephemeral',
    ],
    answer: 0,
    explain:
      'The ZDR request contract — history without sessionId on, sessionId with history off — is enforced server-side.',
  },
  {
    id: 'v03',
    category: 'Metrics & privacy',
    q: "What happens to a ZDR turn's chat-composer attachments?",
    options: [
      'Erased with the turn',
      'Persisted like normal assets',
      'Rejected outright',
      'Kept for 24 hours',
    ],
    answer: 0,
    explain:
      'They ride a throwaway ephemeral flag — the row and the Spaces object are erased with the turn, including on error paths.',
  },
  {
    id: 'v04',
    category: 'Metrics & privacy',
    q: 'First-enabling ZDR does what to existing chat data?',
    options: [
      'Soft-deletes sessions and messages',
      'Leaves everything in place',
      'Exports and clears Spaces',
      'Strips the user id off rows',
    ],
    answer: 0,
    explain:
      'Enabling ZDR is destructive by design — prior sessions soft-delete and their messages hard-delete.',
  },
  {
    id: 'v05',
    category: 'Metrics & privacy',
    q: 'In the metrics subdoc, what runs at save time vs after?',
    options: [
      'Deterministic at save, LLM after',
      'All at save, one LLM call',
      'LLM dims first, then counts',
      'Counts for assistants only',
    ],
    answer: 0,
    explain:
      'promptMetrics computes deterministic features synchronously for both roles; metricsService classifies emotional/technical/abstract/sentiment/open-ended fire-and-forget post-save, user messages only.',
  },
  {
    id: 'v06',
    category: 'Metrics & privacy',
    q: 'An aux classification call fails for a user message. metrics.llm is…',
    options: ['Stored as null', 'A neutral fallback', 'The subdoc is omitted', 'Retried until set'],
    answer: 0,
    explain:
      "Fire-and-forget degrades to nulls; inspect with {'metrics.llm': null, role: 'user'}. Parse skips record skipReason 'parse' and warn.",
  },
  {
    id: 'v07',
    category: 'Metrics & privacy',
    q: 'Around "never used to train models", the privacy modal adds…',
    options: [
      "What the claim does and doesn't mean",
      "Each provider's training policy",
      'A per-session opt-out ledger',
      'No caveats whatsoever',
    ],
    answer: 0,
    explain:
      "The PrivacyModal separates the claim's meaning from its limits, and documents incognito mode and factory reset.",
  },
  {
    id: 'v08',
    category: 'Metrics & privacy',
    q: 'ZDR turns never run the honesty guard because…',
    options: [
      'Nowhere exists to write a flag',
      'Aux rejects encrypted input',
      'Guards run for admins only',
      'ZDR turns are all tool turns',
    ],
    answer: 0,
    explain:
      'Flags live on persisted messages; a session-less turn has nowhere to record a verdict — consistent by construction.',
  },

  // ── Redaction & observability ────────────────────────────────────
  {
    id: 'd01',
    category: 'Redaction & observability',
    q: 'The redaction constraint on every log emission path?',
    options: [
      'Shared redaction before output',
      'Error-level only',
      'At the Grafana ingest layer',
      'Raw logs, redacted traces',
    ],
    answer: 0,
    explain:
      'logRedaction governs console/admin-buffer output and traceRedaction applies the same policy to LangSmith spans — long-form prompt content never lands in stderr or the admin logs view.',
  },
  {
    id: 'd02',
    category: 'Redaction & observability',
    q: 'Trace partial mode keeps what on a long prose line?',
    options: [
      'First and last 3 words',
      'The first sentence',
      'Nothing whatsoever',
      'Every fourth word',
    ],
    answer: 0,
    explain:
      'Head/tail 3 words with a [redacted] middle; falls back to full redaction when the match has no spaces or fewer than 12 words.',
  },
  {
    id: 'd03',
    category: 'Redaction & observability',
    q: 'What stays FULLY redacted even in trace partial mode?',
    options: [
      'Secrets, JSON, key-like runs',
      'Errors and stack traces',
      'Quoted payload prose',
      'Long paragraphs of prose',
    ],
    answer: 0,
    explain:
      'JSON-esque blocks can carry embedded keys and whitespace-free runs (b64/keys) have no words to keep — partial reveal would leak key material.',
  },
  {
    id: 'd04',
    category: 'Redaction & observability',
    q: 'How does trace redaction treat errorInfo (message, details, stack)?',
    options: [
      'Verbatim but size-capped',
      'Still fully redacted',
      'Stack redacted only',
      'Swapped for an error code',
    ],
    answer: 0,
    explain:
      'Errors pass verbatim for trace readability, through fresh containers with caps (depth 6, arrays 50, strings 2000) so cycles and size cannot survive into the exporter. Input/output stay redacted.',
  },
  {
    id: 'd05',
    category: 'Redaction & observability',
    q: 'Why does redaction stash user-typed literal [redacted] markers?',
    options: [
      'They would preserve whole lines',
      'They make quotes inconsistent',
      'LangSmith rejects the literal',
      'They let users opt out',
    ],
    answer: 0,
    explain:
      'A literal marker trips the catch-all skip, preserving an attacker-controlled line verbatim. Markers are swapped for placeholders at entry and restored at exit — only rule-emitted markers trigger the skip.',
  },
  {
    id: 'd06',
    category: 'Redaction & observability',
    q: 'Which surface kept the full-redaction default when traces got partial mode?',
    options: [
      'The Grafana/Loki log path',
      'The LangSmith trace path',
      'Error details in traces',
      'The console capture',
    ],
    answer: 0,
    explain:
      'One rule set, two policies — traceRedaction opts into partial; the log path keeps full redaction by default.',
  },
  {
    id: 'd07',
    category: 'Redaction & observability',
    q: 'The admin Logs view over Grafana Loki is…',
    options: [
      'A 24h window, 30s refresh',
      'A live SSE tail',
      'An hourly flushed buffer',
      'A Mongo log collection',
    ],
    answer: 0,
    explain:
      'Retained logs survive deploys (unlike the old in-memory buffer); a filter change re-queries the window because Loki has no incremental cursor.',
  },
  {
    id: 'd08',
    category: 'Redaction & observability',
    q: 'The OCR outage that killed the backend — the failure chain?',
    options: [
      'Bad tessdata path; unhandled worker throw',
      'An index build blocked the loop',
      'A rate-limited presign endpoint',
      'A deploy wiped the tessdata volume',
    ],
    answer: 0,
    explain:
      'TESSDATA_DIR resolved for the tsx layout only → ENOENT in the compiled image → tesseract rethrew worker failures with no errorHandler set → uncaughtException → exit, and the compose service had no restart policy. Fixes: locate tessdata by walking up from __dirname, contain worker failures (errorHandler + withTimeout), restart: unless-stopped.',
  },
  {
    id: 'd09',
    category: 'Redaction & observability',
    q: 'The filesystem-path redaction rule is narrow because…',
    options: [
      'Over-redacting slowed diagnosis',
      'Users type secret-laden paths',
      'Spaces keys are secrets',
      'Paths are fully exempt',
    ],
    answer: 0,
    explain:
      'The redacted paths are code-controlled; blanking them slowed outage diagnosis. The narrow shape (POSIX charset, no scheme, extension-terminated, ≤64 chars) keeps human content in logs.',
  },

  // ── Files & storage ──────────────────────────────────────────────
  {
    id: 'f01',
    category: 'Files & storage',
    q: 'The Spaces storage boundary is physically enforced by…',
    options: [
      'ESLint restricted imports',
      'A runtime capability check',
      'A single-workspace SDK install',
      'A CI grep',
    ],
    answer: 0,
    explain:
      'no-restricted-imports: only workspaceStorage.ts and tests may import storageService.ts directly. The agnostic surface is WorkspaceStorage (put/get/getStream/delete/list) — lint-enforced, not convention.',
  },
  {
    id: 'f02',
    category: 'Files & storage',
    q: 'The two Spaces key layouts?',
    options: [
      'chats/ and assets/ under userId',
      'A flat userId/filename space',
      'Bucket-root level splits',
      'UUIDs, layout in Mongo',
    ],
    answer: 0,
    explain:
      '<userId>/chats/<chatId>/<filename> vs <userId>/<assetId>/<filename> via the RawKeyStorage byKey subset (assets carry keys on documents, no chatId) — structurally disjoint.',
  },
  {
    id: 'f03',
    category: 'Files & storage',
    q: 'In a NEW session, the agent finds a page it cached via fetch_url by…',
    options: [
      'list_files, with a sourceUrl field',
      'An emailed confirmation fileId',
      'Nothing — scoped to the session',
      'Re-running the original fetch',
    ],
    answer: 0,
    explain:
      "list_files includes system-side rows by default with a sourceUrl field. Discovery used to ride the fetch_url result's fileId — lost across sessions, the agent concluded its save had failed.",
  },
  {
    id: 'f04',
    category: 'Files & storage',
    q: "Does the chat composer's attach menu list agent-cached (system-side) files?",
    options: [
      'No — the API default excludes them',
      'Yes, with an "agent" badge',
      'Yes, under 1 MB only',
      'Only via the Agent-files toggle',
    ],
    answer: 0,
    explain:
      'Two audiences: the attach picker calls the list endpoint with no params (server default excludes system-side), while the list_files TOOL includes them; the Files view gets a segmented toggle.',
  },
  {
    id: 'f05',
    category: 'Files & storage',
    q: 'read_file gets both a valid id and a matching filename. What wins?',
    options: [
      'The valid id wins',
      'The filename wins',
      'The oldest row wins',
      'The call needs one only',
    ],
    answer: 0,
    explain:
      "Resolution order: a valid id wins; otherwise the newest ready row with the sanitized filename across the caller's library; neither → not_found.",
  },
  {
    id: 'f06',
    category: 'Files & storage',
    q: "generate_file is called with an existing USER UPLOAD's name. It…",
    options: [
      'Creates a separate row',
      'Versions the upload',
      'Fails with a 409',
      'Replaces the upload',
    ],
    answer: 0,
    explain:
      "Version-on-duplicate applies only to system-generated rows — the agent must not silently overwrite content it didn't create. Uploads and cached pages always get distinct rows.",
  },
  {
    id: 'f07',
    category: 'Files & storage',
    q: 'The daily version-prune sweep deletes…',
    options: [
      'Superseded versions over a year',
      'Versions older than 30 days',
      'Versions nothing references',
      'System assets past their TTL',
    ],
    answer: 0,
    explain:
      'AssetVersion rows older than one year where a newer version of the same asset exists — its own poller module (the traceStatsPoller pattern), started under the non-test gate.',
  },
  {
    id: 'f08',
    category: 'Files & storage',
    q: 'read_file pages through a cached fetch_url page without a Spaces object by…',
    options: [
      'Reading the stored row text',
      'Re-fetching the original URL',
      'Rebuilding from versions',
      'It cannot',
    ],
    answer: 0,
    explain:
      'system-side rows keep their extracted text on the row; persistence and the 30-day TTL were verified fine — the only historical gap was discovery, not storage.',
  },
  {
    id: 'f09',
    category: 'Files & storage',
    q: 'The asset confirm step (after the browser PUT) does…',
    options: [
      'A real HEAD, size reconciled',
      'Nothing — the presign suffices',
      'A checksum comparison',
      'A quick malware scan',
    ],
    answer: 0,
    explain:
      'Real HEAD with size reconciliation, light text extraction for txt/md/csv (truncated), stale-pending rejection, and a hasText marker surfaced as a composer toast.',
  },
  {
    id: 'f10',
    category: 'Files & storage',
    q: 'Where does Spaces-only functionality (presigns, the config probe) live?',
    options: [
      'In SpacesCapabilities',
      'On the WorkspaceStorage interface',
      'In a dedicated spacesService',
      'Inlined in the asset routes',
    ],
    answer: 0,
    explain:
      'Deliberately NOT on the agnostic WorkspaceStorage interface — it stays landing-zone-clean (a local backend stays possible); the Spaces-specific surface is quarantined.',
  },

  // ── Connectors ───────────────────────────────────────────────────
  {
    id: 'c01',
    category: 'Connectors',
    q: 'A third-party capability like the Things To Do API integrates via…',
    options: [
      'A catalog entry + the MCP client',
      'A hand-written per-provider REST client',
      'A LangChain tool wrapper',
      'A Mongo sync cron job',
    ],
    answer: 0,
    explain:
      'The curated CONNECTOR_CATALOG plus the streamable-HTTP MCP client (Bearer paste) is the extension surface — a first-class REST client would be glue code the connector system obsoletes.',
  },
  {
    id: 'c02',
    category: 'Connectors',
    q: 'The Things To Do connector authenticates with…',
    options: [
      'A pasted Bearer key',
      'No auth — open endpoint',
      'An OAuth browser redirect',
      'Basic auth',
    ],
    answer: 0,
    explain:
      "authType 'mcp.pat': the endpoint reads and validates the Authorization header (a dummy key gets a 401), which is exactly Tova's Bearer-wrapped PAT paste flow.",
  },
  {
    id: 'c03',
    category: 'Connectors',
    q: 'A user pastes "Authorization: Bearer KEY" into a connector token field. The ingest…',
    options: [
      'Strips the prefix, wraps the key',
      'Stores the string verbatim',
      'Rejects it as invalid JSON',
      'Accepts the doubled header',
    ],
    answer: 0,
    explain:
      'It strips an authorization: prefix and any bearer scheme before wrapping; scheme-only pastes are rejected 400 ("paste the key only"); boundary-safe — "bearerly-key"-style tokens are untouched.',
  },
  {
    id: 'c04',
    category: 'Connectors',
    q: "A catalog entry's instructionsRef can't be resolved. The flow…",
    options: [
      'Falls back to generic copy',
      'Hides the connector',
      'Fails the connectors route',
      'Renders the raw ref string',
    ],
    answer: 0,
    explain: 'instructionsFor degrades to generic setup copy — never a crash or an empty modal.',
  },
  {
    id: 'c05',
    category: 'Connectors',
    q: "MCP server tokens can't be hashed like passwords because…",
    options: [
      "They're replayed in headers",
      'bcrypt caps at 72 bytes',
      'Mongo forbids bcrypt fields',
      'They are hashed',
    ],
    answer: 0,
    explain:
      'Tokens must be replayed verbatim in request headers — a one-way hash cannot reconstruct them. The schema takes authToken (strictObject rejects the old authHeader shape) and the server wraps it into the encrypted headers envelope as Authorization: Bearer.',
  },

  // ── Bootstrap & background ───────────────────────────────────────
  {
    id: 'b01',
    category: 'Bootstrap & background',
    q: 'An uncaughtException reaches the process safety net. It…',
    options: [
      'Exits — except tesseract errors',
      'Always logs and continues',
      'Restarts the server in-process',
      'Forwards the error to clients',
    ],
    answer: 0,
    explain:
      'installProcessSafetyNet: fail-fast process.exit(1), with a stack-shaped carve-out containing tesseract.js worker errors so one OCR worker cannot take the process down.',
  },
  {
    id: 'b02',
    category: 'Bootstrap & background',
    q: 'An unhandled promise rejection, under the safety net?',
    options: [
      'Logged; the process lives',
      'Exits like an uncaught exception',
      'Swallowed silently',
      'Persisted to a dead-letter collection',
    ],
    answer: 0,
    explain:
      'unhandledRejection logs with redactForLog and continues; only uncaughtException exits — the two signals have deliberately different blast radii.',
  },
  {
    id: 'b03',
    category: 'Bootstrap & background',
    q: 'Which workers start only when NOT running tests?',
    options: [
      'The poller cluster',
      'Only the task poller',
      'The Mongo change streams',
      'The SSE heartbeat',
    ],
    answer: 0,
    explain:
      'index.ts startServer gates the cluster — asset job poller, task poller, eval scheduler, trace stats poller, asset version pruner, pending-asset sweeper — behind the non-test check.',
  },
  {
    id: 'b04',
    category: 'Bootstrap & background',
    q: "The scheduled eval runner's default state?",
    options: [
      'Off unless TOVA_EVAL_SCHEDULE=daily',
      'On unless TOVA_EVAL_SCHEDULE=off',
      'Hourly, via TOVA_EVAL_HOUR_UTC',
      'Only via a manual dispatch',
    ],
    answer: 0,
    explain:
      'evalScheduler is default-off and fires once at TOVA_EVAL_HOUR_UTC; scheduled memory evals run the retrieval stage only — gate/judge stages stay off the unattended schedule.',
  },
  {
    id: 'b05',
    category: 'Bootstrap & background',
    q: 'How does the eval scheduler avoid double-running after a restart?',
    options: [
      'A has-run check for the UTC day',
      'A lock file written under /tmp',
      'Deduplication by the cron daemon',
      'Nothing — it always re-runs',
    ],
    answer: 0,
    explain:
      'hasRunForUtcDay checks for any run (any status) within the current UTC day — a failed run still counts as "ran today".',
  },
  {
    id: 'b06',
    category: 'Bootstrap & background',
    q: 'Unconfirmed presign uploads are bounded by…',
    options: [
      '40 live pending per user',
      'No cap — presigns are cheap',
      'A global cap of 500',
      'One pending at a time',
    ],
    answer: 0,
    explain:
      'assetPresign: MAX_PENDING_ASSETS 40 per user, a pending TTL (2× the confirm window), and a pending-asset sweeper poller — unconfirmed presigns cannot pool up.',
  },
];
