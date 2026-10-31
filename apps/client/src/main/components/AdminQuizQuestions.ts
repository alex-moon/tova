// Quiz bank for #419: one question per pipeline "idea", sourced from
// apps/server/src/main. Correct option is at `answer`; the view shuffles option
// order at render. Player-facing copy refers only to modules/mechanisms —
// never to tickets, tests, or the dev process.
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
      'The CHAT_MODEL env var (default zai-org/GLM-5.3-Flash)',
      'A Mongo roster ranked by measured TTFT × price',
      'An aux classifier judging prompt complexity',
      'The TASK_MODEL env var, which chat shares',
    ],
    answer: 0,
    explain:
      'Models are env-pinned per function in modelDefaults.ts — CHAT_MODEL defaults to GLM-5.3-Flash; there is no Mongo roster and no complexity classifier.',
  },
  {
    id: 'r02',
    category: 'Routing & racing',
    q: 'Why do tasks always ride DeepInfra instead of racing providers?',
    options: [
      'DS4.1F is not maintained on Fireworks and the unversioned id is priced higher there',
      'Fireworks does not support tool calling',
      'DeepInfra has an exclusivity contract',
      'Fireworks only serves streaming requests',
    ],
    answer: 0,
    explain:
      'modelDefaults.ts: "DS4.1F is fireworks-stale" — stale maintenance and a higher unversioned price, so tasks pin DeepInfra.',
  },
  {
    id: 'r03',
    category: 'Routing & racing',
    q: 'How does the hedged chat race in chatRace.ts pick a winner?',
    options: [
      'Fire the model on all known backends concurrently; first token wins, losers aborted',
      'Try providers sequentially until one succeeds',
      'Ask both providers for a full answer, then score and pick the better one',
      "Weight providers by last turn's TTFT and pick one",
    ],
    answer: 0,
    explain:
      'chatRace.ts fires every backend of CHAT_MODEL at once — the first token/resolution wins and the losers are aborted.',
  },
  {
    id: 'r04',
    category: 'Routing & racing',
    q: 'Why must a losing completion race attempt be aborted (not left to finish)?',
    options: [
      'It would run the full agent loop in the background — duplicate tool side effects and double token spend',
      'It would corrupt the TTFT statistics',
      'Mastra cannot have two completions open',
      'The loser would overwrite the persisted message',
    ],
    answer: 0,
    explain:
      'A background loser re-runs the whole agent loop — a second delegate_task/generate_file — and spends tokens twice, so each attempt gets an abort controller killed on the win.',
  },
  {
    id: 'r05',
    category: 'Routing & racing',
    q: 'What happens if CHAT_MODEL is set to a model id Tova does not know?',
    options: [
      'It rides DeepInfra alone, verbatim — no race',
      'Chat fails loudly with a config error',
      'It silently falls back to the default chat model',
      'It races both providers under the display id',
    ],
    answer: 0,
    explain:
      'chatBackends(): only known defaults have a backend map; an unknown override rides DeepInfra alone.',
  },
  {
    id: 'r06',
    category: 'Routing & racing',
    q: 'When does the SSE stream emit its `meta` event?',
    options: [
      'After the race resolves — so it names the provider that actually serves the turn',
      'Before the race starts, naming the pre-picked provider',
      'Together with the first delta',
      'Only on errors, as a trailer',
    ],
    answer: 0,
    explain:
      'The chat route sends meta after the race resolves and before any delta, so it names the provider that won.',
  },
  {
    id: 'r07',
    category: 'Routing & racing',
    q: 'Which of these is NOT part of the current routing stack?',
    options: [
      'Provider cool-offs with a disabledUntil timestamp',
      'Hedged provider racing',
      'The static price table',
      'The CHAT_MODEL/TASK_MODEL env vars',
    ],
    answer: 0,
    explain:
      'Cool-offs died with the roster era — a failing backend just loses the race (or fails the turn); TTFT survives as diagnostics only.',
  },
  {
    id: 'r08',
    category: 'Routing & racing',
    q: 'How are max_tokens for a chat turn sized?',
    options: [
      'Against a static context-length table in modelDefaults.ts (both defaults 1048576)',
      "Against the winning provider's reported context window",
      'A fixed 4096 output cap',
      'Proportional to the prompt character count',
    ],
    answer: 0,
    explain:
      'MODEL_CONTEXT_LENGTHS is static so outputTokensFor never needs a live lookup — sizing against a post-race winner would mismatch the pre-race pick.',
  },
  {
    id: 'r09',
    category: 'Routing & racing',
    q: 'A trace carries a pre-retirement, unsuffixed DeepSeek model id. What does the cost estimate do?',
    options: [
      'Still estimates — the price index iterates every priced key, including pre-retirement ids',
      'Returns null because the id is unknown to routing',
      'Returns 0 to avoid breaking rollups',
      'Throws and skips the trace',
    ],
    answer: 0,
    explain:
      "buildPriceIndex covers all of MODEL_PRICES' keys so historical traces keep cost estimates; genuinely unknown ids estimate as null.",
  },
  {
    id: 'r10',
    category: 'Routing & racing',
    q: 'When every backend of the chat model fails, what does the race surface?',
    options: [
      'The most actionable provider error, preferring it over a client-abort signal',
      'A silent empty reply',
      'An automatic retry of the full race, once',
      'A 503 "all models disabled" roster error',
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
      'Diagnostics only — logged and shown, never a routing input',
      'It weights the provider pick per (model, provider)',
      'It decides the race winner after the fact',
      'It is not measured anywhere',
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
      'A static (model, provider) → USD/1M table in modelDefaults.ts',
      'A pricing collection in Mongo, seeded by migration',
      "Fetched live from each provider's price API",
      'Encoded per-provider in the Mastra connectors',
    ],
    answer: 0,
    explain:
      'modelDefaults.ts MODEL_PRICES — static, cached pricing deliberately not modelled; unknown rows estimate as null.',
  },

  // ── Task runtime ──────────────────────────────────────────────────
  {
    id: 't01',
    category: 'Task runtime',
    q: 'What does passing taskMode: true actually do?',
    options: [
      'Selects the lean task agent (lean toolset + task instructions); it forces nothing',
      'Forces tool_choice: "required" on every step',
      'Disables streaming and pins DeepInfra',
      'Grants an extra step budget',
    ],
    answer: 0,
    explain:
      "Forcing toolChoice: 'required' made the text-only settle condition unreachable, so mastraService's option no longer forces anything — it only selects the task agent.",
  },
  {
    id: 't02',
    category: 'Task runtime',
    q: 'What is the task processor\'s settle ("done") condition?',
    options: [
      'A step produced text and no tool calls',
      'A step produced no tool calls, text or not',
      'The model emits a DONE token',
      'stepCount reaches the budget',
    ],
    answer: 0,
    explain:
      "taskProcessor: text !== '' && tools.length === 0 — a text-only step is the final answer.",
  },
  {
    id: 't03',
    category: 'Task runtime',
    q: 'Under a strictly honored tool_choice: "required", what happens to a task?',
    options: [
      'The done condition is unreachable — it churns one tool call per step to the budget',
      'It settles instantly with an intent-only answer',
      'Nothing changes; the model ignores the flag',
      'It crashes the connector',
    ],
    answer: 0,
    explain:
      "done (text, no tools) can never fire under strict 'required'. DeepInfra honors the flag loosely — the other failure mode is an instant bogus 'done' on an intent-only answer.",
  },
  {
    id: 't04',
    category: 'Task runtime',
    q: 'Why is delegate_task removed from the task toolset?',
    options: [
      'A task has no sessionId, so delegation can never succeed',
      'It would recurse infinitely',
      'Mastra forbids nested agents',
      'It doubles the token spend per step',
    ],
    answer: 0,
    explain:
      'delegate_task from a task has no sessionId to delegate to — it can never succeed, so the lean task toolset drops it.',
  },
  {
    id: 't05',
    category: 'Task runtime',
    q: 'What is the default task step budget, and what is the "real runaway fuse"?',
    options: [
      'TASK_MAX_STEPS defaults to 150; the cost cap (TASK_MAX_COST_USD, default $5) is the real fuse',
      '25 steps; the step count is the only fuse',
      '1500 steps; time-to-live of 1 hour',
      'Unlimited steps; only the cost cap exists',
    ],
    answer: 0,
    explain:
      'config.task: 150 because deep investigations paused at 25 far too early; spentUsd >= maxCostUsd pauses the task.',
  },
  {
    id: 't06',
    category: 'Task runtime',
    q: 'What happens to the step budget when you steer or resume a paused task?',
    options: [
      "It is granted a fresh increment (budget.maxSteps $inc'd by config.task.maxSteps)",
      'Nothing — resume at an exhausted cap re-pauses instantly',
      'The budget resets to zero steps used',
      'Steering is refused once half the budget is spent',
    ],
    answer: 0,
    explain:
      'taskService increments budget.maxSteps by config.task.maxSteps on steer/resume, so resuming at the cap no longer re-pauses instantly.',
  },
  {
    id: 't07',
    category: 'Task runtime',
    q: 'How does the heartbeat keep live tasks out of the stale-requeue sweep?',
    options: [
      "A 60s interval touches the task's updatedAt while a step runs; the sweep only reclaims tasks idle >5 min",
      'It pings the provider every 5 minutes',
      'It re-claims the lease on every poll tick',
      'It writes a heartbeat collection row per step',
    ],
    answer: 0,
    explain:
      "taskProcessor: TASK_HEARTBEAT_MS (60s) vs the 5-min cutoff — a legitimately long step is never swept; a crashed task's heart stops and the sweep reclaims it.",
  },
  {
    id: 't08',
    category: 'Task runtime',
    q: 'What does requeueStaleTasks do to a stale task already at MAX_TASK_ATTEMPTS?',
    options: [
      'Fails it with a lastError instead of requeueing',
      'Requeues it one final time with a warning',
      'Pauses it for manual review',
      'Deletes it and its event stream',
    ],
    answer: 0,
    explain:
      "The stale path charges attempts — every other stale requeue $inc's attempts by 1; a poison task can no longer restart forever.",
  },
  {
    id: 't09',
    category: 'Task runtime',
    q: 'What does the leaseToken fence protect against?',
    options: [
      'A frozen processor (laptop sleep): the sweep requeues, a twin claims, and the woken original double-runs',
      'Two users steering the same task',
      'Mongo replica-lag reads',
      'Expired PATs mid-step',
    ],
    answer: 0,
    explain:
      "Claims stamp a leaseToken and every processor read/write is scoped on it — a stale twin's reads miss and it exits; its settle attempt is fenced too.",
  },
  {
    id: 't10',
    category: 'Task runtime',
    q: 'How does task cancellation stop the in-flight step?',
    options: [
      'An AbortController registry (a Set per task) whose signal threads into CompletionOptions.abortSignal',
      'A flag the step loop checks between tokens',
      'Killing the provider connection at the socket level',
      'It cannot — cancel takes effect next step',
    ],
    answer: 0,
    explain:
      "taskProcessor's abort registry is a Set per task — a second registration used to orphan the first; the signal is supported end-to-end via the Mastra connector.",
  },
  {
    id: 't11',
    category: 'Task runtime',
    q: 'Why does the processor re-verify ownership (_id + lease + running) after registering the abort handler?',
    options: [
      'Cancel can land in the window before step start — otherwise a full billed step runs on a cancelled task',
      'Mongo may reorder concurrent writes',
      'The lease expires on every poll',
      'To detect a changed instruction',
    ],
    answer: 0,
    explain:
      'Without the re-check, a cancel landing between the loop-top header read and the abort registration ran a full billed step anyway.',
  },
  {
    id: 't12',
    category: 'Task runtime',
    q: 'How does assembleTaskHistory window the replayed event stream?',
    options: [
      'Newest always rides (truncated if alone too big), the first message is the instruction anchor and always rides, the middle fills newest-first under 200 msgs / 400k chars',
      'Oldest-first under a 2000-char clip',
      'It replays only the last 5 events',
      'It ships the entire stream every step',
    ],
    answer: 0,
    explain:
      "taskSequencer mirrors chat's windowedHistory with task-local constants: instruction anchor + newest guaranteed, bounded middle.",
  },
  {
    id: 't13',
    category: 'Task runtime',
    q: 'What was the replay bug that made tasks stop after one step?',
    options: [
      "An assistant event replayed content OR its tool replay, never both — narration erased the tool exchange from the next step's context",
      'The step budget was spent on a single step',
      'The race aborted the wrong provider',
      'Tool results were truncated to 2000 chars',
    ],
    answer: 0,
    explain:
      'assembleTaskHistory now replays event.content AND the renderToolReplay lines, joined — a narrating tool step no longer erases its own exchange.',
  },
  {
    id: 't14',
    category: 'Task runtime',
    q: 'steerTask appends the steering turn, then re-checks the task status. Why?',
    options: [
      'No cross-collection transactions on standalone dev Mongo, so the TOCTOU race is closed by post-append refusal',
      'To update the heartbeat timestamp',
      'Because Mongo requires a re-read after every write',
      'To detect an expired lease',
    ],
    answer: 0,
    explain:
      'If the task settled during the append, steer returns "refused" — the API no longer claims a turn was queued onto a dead stream.',
  },
  {
    id: 't15',
    category: 'Task runtime',
    q: 'How many pending task completions drain onto a single chat turn?',
    options: [
      'Up to 5, oldest first — the rest stay pending for later turns',
      'All of them, newest first',
      'Exactly one per turn',
      'None — completions require a manual resume',
    ],
    answer: 0,
    explain:
      'pendingCompletionsFor takes a limit (default 5, oldest first) so a backlog cannot flood one turn.',
  },
  {
    id: 't16',
    category: 'Task runtime',
    q: "How is a task step's cost added to budget.spentUsd?",
    options: [
      "From the outcome's token usage via the static price table, $inc'd in the same header write as stepCount — unknown cost increments nothing",
      'A flat per-step fee from config',
      'Estimated from prompt characters before the step',
      'Recomputed from all history after each step',
    ],
    answer: 0,
    explain:
      "estimateCostUsd + priceRowsForModel from the outcome's usage; absent usage or an unpriced model means no increment — unknown cost is never faked.",
  },
  {
    id: 't17',
    category: 'Task runtime',
    q: 'An empty task instruction is rejected by the schema. What does enqueueTask still guard against?',
    options: [
      'If the placeholder seed write fails it deletes the header — but only while the task is still queued',
      'That the instruction is not only whitespace in a second language',
      'That no task with the same name exists',
      'That the provider key is present',
    ],
    answer: 0,
    explain:
      'The compensation (delete header) only runs while the task is still queued — a claim that slipped in during the window is never stranded headerless.',
  },
  {
    id: 't18',
    category: 'Task runtime',
    q: 'taskSequencer clips step text at 2000 chars with .slice, which can split astral surrogates. What is the known consequence?',
    options: [
      'Real for CJK strays (one stray-token class) but cannot explain the English near-miss substitutions (the other class)',
      'It is the root cause of both stray-token classes',
      'It was disproven — the clip never splits surrogates',
      'It only affects task titles',
    ],
    answer: 0,
    explain:
      'The clip split is real for CJK glyphs; class-2 near-misses — valid ASCII both sides, e.g. "arguably"→"argumentatively" — need a different cause entirely.',
  },

  // ── Workspace memory ─────────────────────────────────────────────
  {
    id: 'm01',
    category: 'Workspace memory',
    q: 'When does workspace-memory retrieval run on a text turn?',
    options: [
      'Unconditionally on every non-ZDR text turn — there is no intent gate',
      'Only when an aux classifier votes that the user mentions past work',
      'Only when the user types @memory',
      'Only on the first turn of a session',
    ],
    answer: 0,
    explain:
      "The old aux-vote gate's false-negative class outweighed its value; rerank-and-cut supplies the relevance bar instead (workspaceRetrievalService). Image turns and ZDR stay off.",
  },
  {
    id: 'm02',
    category: 'Workspace memory',
    q: "What is the retrieval pipeline's stage order?",
    options: [
      'BM25 ∪ Atlas vector fused, then a cross-encoder rerank-and-cut',
      'Vector search, then BM25, then dedupe',
      'Rerank first, then BM25 ∪ vector',
      'BM25 only; vectors feed a separate view',
    ],
    answer: 0,
    explain:
      'workspaceRetrievalService: retrieve liberally (fused candidates, capped), then grade absolutely and cut — including cutting everything.',
  },
  {
    id: 'm03',
    category: 'Workspace memory',
    q: 'Which reranker does the cut stage use, and why that one?',
    options: [
      'Qwen/Qwen3-Reranker-0.6B — the bge reranker is no longer served by DeepInfra (404), and Qwen3 shares the {queries, documents} → {scores} contract',
      'BAAI/bge-reranker-v2-m3 — the long-standing default reranker',
      'A local cross-encoder running in the Node process',
      "OpenAI's rerank API via a compatibility shim",
    ],
    answer: 0,
    explain:
      "A calibration probe over the three Qwen3 sizes picked 0.6B for score separation, price, and latency; the bge reranker 404s on DeepInfra's catalog.",
  },
  {
    id: 'm04',
    category: 'Workspace memory',
    q: 'Why is RERANK_CUT = 0.005 corpus-independent?',
    options: [
      "Reranker scores are probabilities — an absolute bar, unlike BM25's corpus-relative scores",
      "It is scaled by the corpus' average document length",
      "It adapts to the session's historical score distribution",
      "It is a percentile of each turn's graded set",
    ],
    answer: 0,
    explain:
      'Calibration: relevant ≈ 0.98+, irrelevant ≤ 0.0009, bare-deixis max 0.0036 — the bar sits in the decade gap and needs no corpus context.',
  },
  {
    id: 'm05',
    category: 'Workspace memory',
    q: 'What is the product behaviour when the rerank cut removes every candidate?',
    options: [
      'No memory block renders — a clean refusal path (e.g. bare-deictic prompts stay quiet)',
      'The fused ranking is returned uncut as a fallback',
      'The turn errors and asks the user to rephrase',
      "BM25's top hit is injected anyway",
    ],
    answer: 0,
    explain:
      'Empty after cut → [] → renderBlock renders no block. "And that one as well?" grades far below the bar and stays quiet.',
  },
  {
    id: 'm06',
    category: 'Workspace memory',
    q: 'The reranker service never throws. What happens when it returns null (provider down, no key, timeout)?',
    options: [
      'The un-cut fused ranking is returned — exactly the pre-rerank behaviour',
      'Retrieval is skipped for that turn',
      'The turn fails loudly',
      'BM25 alone is used',
    ],
    answer: 0,
    explain:
      'Every failure degrades to null; rankWorkspaceSlices then returns the fused order. The kill switch off takes the identical path.',
  },
  {
    id: 'm07',
    category: 'Workspace memory',
    q: 'What are the caps on the rerank input?',
    options: [
      '24 graded candidates (in RRF order) and 2000 chars of doc text — returned slices keep full text',
      '12 candidates and 500 chars, slices truncated to match',
      'Unlimited candidates, 2000 chars per doc',
      '24 candidates and full document text',
    ],
    answer: 0,
    explain:
      'RERANK_MAX_CANDIDATES 24 / RERANK_DOC_CHARS 2000 (doc text is title\\ncontent); candidateCount reports the graded count for eval diagnostics.',
  },
  {
    id: 'm08',
    category: 'Workspace memory',
    q: 'Why is the chat-message corpus read for retrieval capped at the newest 500 (CHAT_POOL)?',
    options: [
      'To make the per-turn read O(1) instead of O(history) — corpus size must not map onto per-turn cost',
      'Because Atlas vector search rejects more than 500 documents',
      'Because older messages are soft-deleted',
      "To bound the reranker's input",
    ],
    answer: 0,
    explain:
      'collectWorkspaceSlices reads .sort({timestamp:-1}).limit(500) — generous for retrieval quality, bounded for cost.',
  },
  {
    id: 'm09',
    category: 'Workspace memory',
    q: 'In workspaceRetrievalService, what does VECTOR_NUM_CANDIDATE_MULTIPLIER change about the Atlas ANN query?',
    options: [
      'numCandidates = limit × 4 — real exploration headroom where numCandidates used to equal limit',
      'The index switched to cosine from dotProduct',
      'Vectors are now quantized to int8',
      'The query now races BM25 for the best recall',
    ],
    answer: 0,
    explain:
      'With numCandidates === limit there was zero exploration over the result window; the ×4 multiplier gives Atlas room to rank.',
  },
  {
    id: 'm10',
    category: 'Workspace memory',
    q: 'What was the title-fold hash-parity bug between the ingest and backfill embedding paths?',
    options: [
      'Ingest folded titles only for kind: file, but backfill folded every kind — chat/task hashes mismatched, so every backfill re-embedded the whole corpus',
      'Embeddings were stored base64 in some rows and raw in others',
      'The model id was missing from the hash, so model swaps went unnoticed',
      'Filenames were lowercased in one path but not the other',
    ],
    answer: 0,
    explain:
      'Fix: fold only for file, in the planner — no production row invalidated, but backfills stop re-embedding titled chat/task slices.',
  },
  {
    id: 'm11',
    category: 'Workspace memory',
    q: 'How does factory-reset purge avoid leaking content-derived embedding vectors from in-flight embeds?',
    options: [
      'A per-user in-flight registry is drained before the Mongo sweep and once more after it',
      'All embeds are made synchronous during purge',
      'Vectors are encrypted at rest with a per-user key',
      'The purge deletes the whole collection for everyone',
    ],
    answer: 0,
    explain:
      'workspaceEmbeddingIngest keeps a registry of in-flight embeds; drainUserEmbeddings(uid) runs pre- and post-sweep. A genuinely concurrent post-reset turn is new content, not leaked data.',
  },
  {
    id: 'm12',
    category: 'Workspace memory',
    q: 'Why does a dim change re-embed rows via a query filter instead of folding dim into the text hash?',
    options: [
      'Folding dim into the hash would change every digest and trigger a one-time full re-embed of every corpus on deploy',
      'The hash must stay stable for the reranker',
      'Mongo cannot index hashed dim fields',
      'It does fold dim into the hash',
    ],
    answer: 0,
    explain:
      'embedWorkspaceUser filters dim at the skip lookup — stale-dim rows never satisfy it and re-embed; the Atlas index itself needs a manual recreate (numDimensions is fixed at creation).',
  },
  {
    id: 'm13',
    category: 'Workspace memory',
    q: 'Which kinds of content become workspace slices (the retrieval corpus)?',
    options: [
      "Chat messages, file contents, and task event transcripts — kind: 'chat' | 'file' | 'task'",
      'Chat messages only',
      'Files and uploaded assets only',
      'Chat messages and web pages fetched via fetch_url',
    ],
    answer: 0,
    explain:
      'workspaceEmbeddingText/workspaceRetrievalService build slices from all three sources; fetch_url pages enter as kind: file (system-side assets).',
  },
  {
    id: 'm14',
    category: 'Workspace memory',
    q: 'Which embedding model and provider does the workspace stack use?',
    options: [
      'BAAI/bge-base-en-v1.5 on DeepInfra',
      'text-embedding-3-small on OpenAI',
      'BAAI/bge-m3 on Fireworks',
      'A local sentence-transformers build',
    ],
    answer: 0,
    explain:
      'config.embeddings defaults to BAAI/bge-base-en-v1.5; embeddingService is a thin DeepInfra fetch client with write-side dim validation.',
  },
  {
    id: 'm15',
    category: 'Workspace memory',
    q: 'In workspace traces, what are the three possible memory-gate labels?',
    options: [
      'off (image turn / kill switch), yes (block non-empty), no (empty after retrieval or cut)',
      'yes / no / unknown',
      'hit / miss / partial',
      'on / off / degraded',
    ],
    answer: 0,
    explain:
      'workspaceGateFrom re-derives the label from the retrieval outcome — there is no aux call left to time out.',
  },

  // ── Aux model & honesty guard ────────────────────────────────────
  {
    id: 'a01',
    category: 'Aux model & honesty guard',
    q: 'Which model serves the auxiliary calls, on which provider?',
    options: [
      'openai/gpt-oss-20b on Groq — via AUX_MODEL/AUX_PROVIDER',
      'zai-org/GLM-5.3-Flash on DeepInfra',
      'gpt-4o-mini on OpenAI',
      'Whatever CHAT_MODEL is set to',
    ],
    answer: 0,
    explain:
      'config: one cheap fixed aux source (AUX_MODEL/AUX_PROVIDER) feeds all side calls, independent of the chat/task models.',
  },
  {
    id: 'a02',
    category: 'Aux model & honesty guard',
    q: 'Which of these is NOT an auxiliary LLM call site?',
    options: [
      'Entity extraction',
      'Chat title',
      'Follow-up suggestions',
      'Prompt-metric classification',
    ],
    answer: 0,
    explain:
      'The five aux sites are titleService, subtitleService, followupService, metricsService, and honestyGuardService — an entity-graph extractor existed once and was removed outright.',
  },
  {
    id: 'a03',
    category: 'Aux model & honesty guard',
    q: 'Why did the honesty guard and metrics classifier get max_tokens raised to 1024?',
    options: [
      'gpt-oss-20b is a reasoning model — hidden chain-of-thought starved the old 120/100 budgets before any answer was emitted',
      'Traces showed truncated JSON from long prompts',
      'Groq requires a 1024 minimum',
      'To fit the full conversation history in the verdict',
    ],
    answer: 0,
    explain:
      'Budgets of 120/100 left nothing after hidden reasoning; 1024 is a safety bound, not a cost driver. Title/subtitle stay at 512.',
  },
  {
    id: 'a04',
    category: 'Aux model & honesty guard',
    q: 'What happens when an aux classifier returns an empty or length-truncated verdict?',
    options: [
      'It is detected, warned once, and left unassessed — never scored as clean',
      'It silently records a fallback clean verdict',
      'The whole turn is retried',
      'The message is deleted',
    ],
    answer: 0,
    explain:
      'A fallback-to-clean verdict was worse than no verdict — garbage now returns null with a single-line warn, leaving the message unassessed.',
  },
  {
    id: 'a05',
    category: 'Aux model & honesty guard',
    q: "When is the honesty guard's aux call deterministically skipped?",
    options: [
      'When the turn executed at least one tool — the flag rule ("claims tool use, zero executed tools") is unreachable',
      'When the message is under 50 characters',
      'When the user has ZDR on',
      'When the guard model is cooling off',
    ],
    answer: 0,
    explain:
      'honestyGuardService: a turn with executed tools can never meet the flag rule, so the call is skipped — cheaper than asking every turn.',
  },
  {
    id: 'a06',
    category: 'Aux model & honesty guard',
    q: 'What does an ABSENT honesty subdoc on a message mean?',
    options: [
      'Not assessed — the aux call or parse failed; there is no synthetic false',
      'The turn was verified clean',
      'The turn was flagged but muted',
      'The guard is disabled globally',
    ],
    answer: 0,
    explain:
      'The flag subdoc is {flagged, reason, checkedAt}; absence means unassessed, deliberately distinct from a clean verdict.',
  },
  {
    id: 'a07',
    category: 'Aux model & honesty guard',
    q: 'How does the honesty self-correction reach the model at the next turn boundary?',
    options: [
      "A bracketed corrective note appended to the current user turn's prompt content — never persisted, never shown",
      'A system message injected into Mongo history',
      'A re-write of the flagged assistant message',
      'A client-side banner the user must dismiss',
    ],
    answer: 0,
    explain:
      'The note rides prompt assembly (same mechanism as the provenance line) when the newest assistant message in history is flagged.',
  },
  {
    id: 'a08',
    category: 'Aux model & honesty guard',
    q: 'Why is the honesty auto-retry a server-side restart rather than a client auto-click of "Retry for real"?',
    options: [
      'The client retry resends the user message as a new persisted turn — a duplicate bubble; the restart persists nothing about the dishonest attempt',
      'The client cannot reach the aux model',
      'Server-side retries are free',
      'The guard verdict is only available server-side after persistence',
    ],
    answer: 0,
    explain:
      'Restarting inside the stream request keeps the transcript clean — the flagged attempt is never persisted.',
  },
  {
    id: 'a09',
    category: 'Aux model & honesty guard',
    q: 'The honesty retry is bounded at two attempts. What happens when the retry is also flagged?',
    options: [
      'Fall back to flag-and-badge: persist the flag, send the post-done honesty frame, keep the manual retry button',
      'Retry up to five times, then give up',
      'Persist the flagged reply as clean',
      'Cancel the turn entirely',
    ],
    answer: 0,
    explain:
      'Bounded to one retry; the exhausted path restores the badge + manual "Retry for real" as last resort.',
  },
  {
    id: 'a10',
    category: 'Aux model & honesty guard',
    q: 'Which latency cost did the honesty auto-retry knowingly accept?',
    options: [
      "Attempt 1's dishonest text streams live before being wiped — buffering every turn would kill live streaming",
      'A 10s delay before every stream starts',
      'Double token spend on every turn',
      'The verdict blocks the first delta',
    ],
    answer: 0,
    explain:
      'The transient flash is unavoidable without buffering; deltas are fully streamed by the time the guard runs.',
  },
  {
    id: 'a11',
    category: 'Aux model & honesty guard',
    q: 'Where does the ~1s honesty-guard aux call land on tool-free streaming turns?',
    options: [
      'Between stream end and done — tail latency on an already-rendered reply',
      'Before the first delta',
      'In parallel with the deltas',
      'It was moved to the next user turn',
    ],
    answer: 0,
    explain:
      "done (which finalizes the client's bubble) only fires after the final attempt passes, so the guard is tail latency on a rendered reply.",
  },
  {
    id: 'a12',
    category: 'Aux model & honesty guard',
    q: "There was a bug where a flagged reply's live badge never appeared without a refresh. What was it?",
    options: [
      'The post-done honesty frame targeted the streamId bubble, but done had already renamed it to the persisted id',
      'The badge CSS was behind a media query',
      'The frame arrived before done, closing the stream early',
      'The frame leaked the flagged text and was dropped by redaction',
    ],
    answer: 0,
    explain:
      'The handler now matches the adopted persisted id (done renames the streamId bubble), so the badge appears live.',
  },

  // ── System prompt ────────────────────────────────────────────────
  {
    id: 's01',
    category: 'System prompt',
    q: "In the system prompt, what is Tova told to say when asked which model it's built on?",
    options: [
      "Answer simply that it's Tova; do not name underlying providers or models",
      'Name the serving model and provider honestly',
      'Decline to answer any question about itself',
      'Say it is a GLM model fine-tuned for Tova',
    ],
    answer: 0,
    explain:
      'promptAssembly.ts SYSTEM_PROMPT: "If asked what model or AI you\'re built on, answer simply: you\'re Tova. Do not name underlying providers or models."',
  },
  {
    id: 's02',
    category: 'System prompt',
    q: 'What exactly does the anti-fabrication rule in the system prompt forbid?',
    options: [
      'Stating that you read, searched, fetched, checked, or ran anything unless that call actually executed in this conversation',
      'Quoting file contents without a citation header',
      'Describing future work in the present tense',
      'Mentioning tool names the user cannot see',
    ],
    answer: 0,
    explain:
      'The rule: never state you read/searched/fetched/checked/ran anything unless the call executed in this conversation — describing work you did not do is fabrication.',
  },
  {
    id: 's03',
    category: 'System prompt',
    q: 'What does timestampHeader render on each history message?',
    options: [
      '[date time zone], optionally with a relative gap ("2 days since the last message") — no gap line under an hour',
      'A Unix epoch in brackets',
      'The message index within the session',
      'Nothing — timestamps are client-side only',
    ],
    answer: 0,
    explain:
      'promptAssembly: the largest unit (year→hour) whose rounded value is ≥ 1 renders; under an hour there is no gap line. ZDR turns keep the bare date line as their only clock.',
  },
  {
    id: 's04',
    category: 'System prompt',
    q: "A user's stored IANA timezone is unknown to Intl at assembly time. What does the clock do?",
    options: [
      'Falls back to UTC — honest rather than wrong',
      'Throws and fails the turn',
      "Uses the server's local zone",
      'Omits the timestamp entirely',
    ],
    answer: 0,
    explain:
      'clockIn catches the failure and renders the UTC stamp; unknown stored zones never break assembly.',
  },
  {
    id: 's05',
    category: 'System prompt',
    q: 'How are user-controlled strings (custom instructions, profile fields) embedded into the system prompt?',
    options: [
      'Inside envelope delimiters as visibly data, with forged closers escaped (escapeEnvelopeBreakers) — prompt-injection containment',
      'Concatenated as plain assistant-voice text',
      'Base64-encoded to prevent injection',
      'Only sent as a separate user message after the prompt',
    ],
    answer: 0,
    explain:
      "buildUserEnvelope/escapeEnvelopeBreakers (content/attachmentEnvelope): user strings ride in envelopes, visibly data; taggedBlock escapes forged closers so the model can't be closed-and-forged mid-block.",
  },
  {
    id: 's06',
    category: 'System prompt',
    q: 'What does the workspace-memory envelope intro tell the model about the block?',
    options: [
      'It may be stale or superseded, use it only where relevant, and never read it back verbatim',
      'Treat it as ground truth for all past events',
      'Summarize it at the start of every reply',
      'It is confidential — never refer to it',
    ],
    answer: 0,
    explain:
      'WORKSPACE_INTRO in promptAssembly: connect the question with past work; do not assert it as fact if the current chat contradicts it.',
  },
  {
    id: 's07',
    category: 'System prompt',
    q: 'The task:completed block asks the model to report finished background tasks how?',
    options: [
      "Briefly — what finished and the key result; do not repeat the task's full output",
      'Verbatim, including the full transcript',
      'Only if the user asks first',
      'As a downloadable file reference',
    ],
    answer: 0,
    explain:
      'TASK_COMPLETION_INTRO in promptAssembly: brief mention + key result; the full output lives in the task stream.',
  },
  {
    id: 's08',
    category: 'System prompt',
    q: "The user's verified-account full name rides in the system prompt. What rule governs its use?",
    options: [
      'Never address the user by it; surface it only if they ask, and prompt them to set a preferred name',
      'Use it always — it is the verified identity',
      'Use it only in the first message of a session',
      'It is included for audit only and hidden from the model',
    ],
    answer: 0,
    explain:
      'profileContextBlock: the full name comes from a verified identity account; the preferred name is the addressable one.',
  },

  // ── Metrics & privacy ────────────────────────────────────────────
  {
    id: 'v01',
    category: 'Metrics & privacy',
    q: 'With ZDR enabled, what persistence does a chat turn do?',
    options: [
      'None — session-less: no Session or Message rows, no title or classification writes',
      'Messages only, stripped of identifiers',
      'Everything, encrypted with a per-user key',
      'Messages in a separate zdr collection, purged daily',
    ],
    answer: 0,
    explain:
      'Continuity rides a client-replayed capped history payload; nothing about the turn is stored.',
  },
  {
    id: 'v02',
    category: 'Metrics & privacy',
    q: 'What does the server do with a chat request that carries a sessionId while the sender has ZDR on?',
    options: [
      'Rejects it with 409',
      'Silently drops the sessionId',
      'Accepts it and persists as usual',
      'Accepts but marks the session ephemeral',
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
      'They ride a throwaway ephemeral flag — row and Spaces object erased with the turn, including on error paths',
      'They persist like normal assets',
      'They are rejected outright',
      'They are kept for 24 hours then purged',
    ],
    answer: 0,
    explain:
      'Ephemeral attachments are erased with the turn — even a failed turn must not leave the row or the Spaces object behind.',
  },
  {
    id: 'v04',
    category: 'Metrics & privacy',
    q: 'What does first-enabling ZDR do to existing chat data?',
    options: [
      'Soft-deletes prior sessions and hard-deletes their messages',
      'Nothing — old data stays, new turns are session-less',
      'Exports everything and clears the Spaces bucket',
      'Anonymizes the sessions by stripping the user id',
    ],
    answer: 0,
    explain:
      'Enabling ZDR is destructive by design — sessions soft-delete and their messages hard-delete.',
  },
  {
    id: 'v05',
    category: 'Metrics & privacy',
    q: 'In the per-message metrics subdoc, what is computed synchronously at save time vs after?',
    options: [
      'Deterministic features (counts, buckets, indicators) at save; LLM-classified dimensions fire-and-forget post-save, user messages only',
      'Everything is computed at save by the same LLM call',
      'LLM dims first, deterministic features after the reply',
      'Deterministic features for assistants only; users get LLM dims',
    ],
    answer: 0,
    explain:
      'promptMetrics runs synchronously for both roles; metricsService classifies emotional/technical/abstract/sentiment/open-ended post-save via the aux model.',
  },
  {
    id: 'v06',
    category: 'Metrics & privacy',
    q: 'An aux classification call fails for a user message. What is stored in metrics.llm?',
    options: [
      "null — inspectable via {'metrics.llm': null, role: 'user'}; the skip reason lands in the logs with a warn",
      'A fallback classification of all-neutral',
      'The subdoc is omitted entirely',
      'The message save is retried until it succeeds',
    ],
    answer: 0,
    explain:
      "Fire-and-forget degrades to nulls on failure; parse skips record skipReason 'parse' and warn.",
  },
  {
    id: 'v07',
    category: 'Metrics & privacy',
    q: 'The privacy statement says chats/files are "never used to train models". What does the privacy modal add around that claim?',
    options: [
      'What the claim means and does not mean, plus incognito/factory-reset explanations and the capabilities panel',
      "A list of every provider's training policy",
      'A per-session opt-out ledger',
      'Nothing — the claim is stated verbatim with no caveats',
    ],
    answer: 0,
    explain:
      "The PrivacyModal separates the claim's meaning from its limits and documents incognito and factory reset.",
  },
  {
    id: 'v08',
    category: 'Metrics & privacy',
    q: 'Why do ZDR turns never run the honesty guard?',
    options: [
      'Nothing persists, so there is no flag subdoc to write and no history to correct against',
      'The aux model cannot handle encrypted input',
      'The guard only runs on admin accounts',
      'ZDR turns are always tool turns',
    ],
    answer: 0,
    explain:
      'Flags live on persisted messages; a session-less turn has nowhere to record a verdict — consistent by construction.',
  },

  // ── Redaction & observability ────────────────────────────────────
  {
    id: 'd01',
    category: 'Redaction & observability',
    q: 'What is the long-lived redaction constraint on log emission?',
    options: [
      'Every log emission path passes shared redaction before output — logRedaction governs console/admin-buffer output, traceRedaction applies the same policy to LangSmith spans',
      'Only error-level logs are redacted',
      'Redaction happens at the Grafana ingest layer',
      'Logs are raw; only traces are redacted',
    ],
    answer: 0,
    explain:
      'Long-form prompt content never lands in stderr or the admin logs view; the residual gaps are documented rather than hidden.',
  },
  {
    id: 'd02',
    category: 'Redaction & observability',
    q: "In trace redaction's partial mode, what survives redaction on a long prose line?",
    options: [
      'The first and last 3 words with a [redacted] middle',
      'The first sentence only',
      'Nothing — partial mode is keyword-only',
      'Every fourth word',
    ],
    answer: 0,
    explain:
      'traceRedaction opts into partial mode: head/tail 3 words; falls back to full redaction when the match has no spaces or fewer than 12 words.',
  },
  {
    id: 'd03',
    category: 'Redaction & observability',
    q: 'Which content stays FULLY redacted even in trace partial mode?',
    options: [
      'Secret-shaped assignments, JSON-esque blocks, and whitespace-free runs (b64/keys)',
      'Error messages',
      'Quoted payload text',
      'Long prose paragraphs',
    ],
    answer: 0,
    explain:
      'JSON can carry embedded keys and whitespace-free runs have no words to keep — partial reveal would leak key material.',
  },
  {
    id: 'd04',
    category: 'Redaction & observability',
    q: 'How does trace redaction treat errorInfo (message, details, stack)?',
    options: [
      'Passes verbatim, but details is structurally capped (depth 6, arrays 50, strings 2000)',
      'Still fully redacted',
      'Only the stack is redacted',
      'Replaced by an error code',
    ],
    answer: 0,
    explain:
      'Errors pass verbatim for trace readability, through fresh containers with caps so cycles and size cannot survive into the exporter. Input/output stay redacted.',
  },
  {
    id: 'd05',
    category: 'Redaction & observability',
    q: 'Why does redaction "stash" user-typed literal [redacted] markers?',
    options: [
      'A literal marker would trip the catch-all skip and preserve a whole attacker-controlled line verbatim',
      'To make user quotes look consistent',
      'Because LangSmith rejects the literal string',
      'To let users opt out of redaction per message',
    ],
    answer: 0,
    explain:
      'User markers are swapped for placeholders at entry and restored at exit — only rule-emitted markers trigger the catch-all skip.',
  },
  {
    id: 'd06',
    category: 'Redaction & observability',
    q: 'Which redaction surface stayed conservative (full default) when traces got partial mode?',
    options: [
      'Log redaction (the Grafana/Loki path)',
      'Trace input/output',
      'Error details',
      'The admin logs view',
    ],
    answer: 0,
    explain:
      'One rule set, two policies — traceRedaction opts into partial; the log path keeps full redaction by default.',
  },
  {
    id: 'd07',
    category: 'Redaction & observability',
    q: 'What is the nature of the admin Logs view over Grafana Loki?',
    options: [
      'A 24-hour retained window queried on open and refreshed every 30s — not a live tail',
      'A live SSE tail of stdout',
      'The in-memory buffer, flushed hourly',
      'A Mongo-backed log collection',
    ],
    answer: 0,
    explain:
      'Retained logs survive deploys (unlike the old in-memory buffer); a filter change re-queries the window because Loki has no incremental cursor.',
  },
  {
    id: 'd08',
    category: 'Redaction & observability',
    q: 'In the OCR outage where the first image upload killed the backend, what was the failure chain?',
    options: [
      'TESSDATA_DIR resolved for the tsx layout only → ENOENT in the compiled image → tesseract rethrew worker failures with no errorHandler set → uncaughtException → exit, and the compose service had no restart policy',
      'A Mongo index build blocked the event loop',
      'The Spaces presign endpoint was rate-limited',
      'A deploy wiped the tessdata volume',
    ],
    answer: 0,
    explain:
      'Fixes: tessdata located by walking up from __dirname (tsx lays out src/main/services, the compiled image dist/services), worker failures contained with errorHandler + withTimeout, and restart: unless-stopped.',
  },
  {
    id: 'd09',
    category: 'Redaction & observability',
    q: 'Why are quoted filesystem paths in logs redacted at all, given how narrow the rule is?',
    options: [
      'They are code-controlled, and redacting them slowed outage diagnosis — so the rule is narrow: POSIX charset, no scheme, extension-terminated, ≤64 chars',
      'Because users type paths with passwords in them',
      'Because Spaces keys are secrets',
      'They are not — paths are exempt from redaction',
    ],
    answer: 0,
    explain:
      'The narrow shape keeps human content in logs while still allowing the code paths that diagnose outages.',
  },

  // ── Files & storage ──────────────────────────────────────────────
  {
    id: 'f01',
    category: 'Files & storage',
    q: 'How is the Spaces storage boundary physically enforced?',
    options: [
      'ESLint no-restricted-imports: only workspaceStorage.ts and tests may import storageService.ts directly',
      'A runtime capability check on every call',
      'The Spaces SDK is only installed in one workspace',
      'A CI grep that fails on "spaces" imports',
    ],
    answer: 0,
    explain:
      'The storage-agnostic surface is WorkspaceStorage (put/get/getStream/delete/list) — the boundary is lint-enforced, not convention.',
  },
  {
    id: 'f02',
    category: 'Files & storage',
    q: 'What are the two Spaces key layouts?',
    options: [
      'Chats: <userId>/chats/<chatId>/<filename>; assets: <userId>/<assetId>/<filename> via RawKeyStorage — structurally disjoint',
      'A single flat <userId>/<filename> namespace',
      'Chats under /chats/..., assets under /assets/... at the bucket root',
      'UUID keys with the layout stored in Mongo only',
    ],
    answer: 0,
    explain:
      'Asset keys live on documents (assets have no chatId), accessed through the explicit RawKeyStorage byKey subset; Spaces extras live in SpacesCapabilities, not the interface.',
  },
  {
    id: 'f03',
    category: 'Files & storage',
    q: 'How does the agent discover a page it cached via fetch_url in a NEW session?',
    options: [
      'list_files includes system-side rows by default, carrying sourceUrl so the agent can match them to mentioned URLs',
      'The fileId is emailed to the user',
      'It cannot — discovery is session-scoped by design',
      'The user must re-run fetch_url',
    ],
    answer: 0,
    explain:
      "Discovery used to ride the fetch_url result's fileId, which is lost across sessions — the agent concluded its save had failed and told the user so.",
  },
  {
    id: 'f04',
    category: 'Files & storage',
    q: "Does the chat composer's attach menu list agent-cached (system-side) files?",
    options: [
      'No — it calls the list endpoint with no params, and the server default excludes system-side; the TOOL includes them, the API does not',
      'Yes — they appear with an "agent" badge',
      'Yes, but only files under 1 MB',
      'Only when the user toggles "Agent files"',
    ],
    answer: 0,
    explain:
      'Two audiences: the Files view gets a segmented "My files"/"Agent files" toggle; the attach picker keeps the server\'s excluding default.',
  },
  {
    id: 'f05',
    category: 'Files & storage',
    q: 'When both an id and a filename could resolve in read_file/edit_file, which wins?',
    options: [
      "A valid id wins; otherwise the newest ready row with the sanitized filename across the caller's library",
      'The filename always wins',
      'The oldest matching row',
      'The call fails — you must use exactly one',
    ],
    answer: 0,
    explain: 'Resolution order: valid id → newest ready filename match → not_found.',
  },
  {
    id: 'f06',
    category: 'Files & storage',
    q: 'generate_file called with the name of an existing USER UPLOAD — what happens?',
    options: [
      "A separate new row is created — the agent must not silently overwrite content it didn't create",
      'A new version of the upload is written, id preserved',
      'The call fails with a 409',
      'The upload is soft-deleted and replaced',
    ],
    answer: 0,
    explain:
      'Version-on-duplicate applies only to system-generated rows; uploads and cached pages always get distinct rows.',
  },
  {
    id: 'f07',
    category: 'Files & storage',
    q: 'What does the daily version-prune sweep delete?',
    options: [
      'AssetVersion rows older than one year where a newer version of the same asset exists',
      'All versions older than 30 days',
      'Any version not attached to a live message',
      'System-side assets past their 30-day TTL',
    ],
    answer: 0,
    explain:
      'Its own poller module (the traceStatsPoller pattern), started under the non-test gate in index.ts.',
  },
  {
    id: 'f08',
    category: 'Files & storage',
    q: 'How does read_file page through a fetch_url-cached page without a Spaces object?',
    options: [
      'system-side rows keep their extracted text on the row — read_file serves the stored text directly',
      'It re-fetches the original URL',
      'It reconstructs the object from the version history',
      'It cannot — system-side rows are unreadable',
    ],
    answer: 0,
    explain:
      'Persistence and the 30-day TTL were verified fine — the only historical gap was discovery, not storage.',
  },
  {
    id: 'f09',
    category: 'Files & storage',
    q: 'What does the asset confirm step do after a browser PUT to Spaces?',
    options: [
      'A real HEAD with size reconciliation, light text extraction for txt/md/csv (truncated), stale-pending rejection, and a hasText marker surfaced as a composer toast',
      'Nothing — the presign URL guarantees the upload',
      'A checksum comparison against the client hash',
      'A virus scan',
    ],
    answer: 0,
    explain:
      'Presign (allowlist + 15 MB cap, 60s PUT) → PUT → confirm (real HEAD); hasText is a composer toast so "no extracted text" is user-visible.',
  },
  {
    id: 'f10',
    category: 'Files & storage',
    q: 'Where does Spaces-only functionality (presigns, the config probe) live?',
    options: [
      'In SpacesCapabilities — deliberately NOT on the agnostic WorkspaceStorage interface',
      'On the WorkspaceStorage interface as optional methods',
      'In a separate spacesService used by routes directly',
      'Inlined in the asset routes',
    ],
    answer: 0,
    explain:
      'The agnostic surface stays landing-zone-clean (a local backend stays possible); the Spaces-specific surface is quarantined.',
  },

  // ── Connectors ───────────────────────────────────────────────────
  {
    id: 'c01',
    category: 'Connectors',
    q: 'How does Tova integrate a third-party capability like the Things To Do events API?',
    options: [
      'A curated CONNECTOR_CATALOG entry + the existing MCP client (streamable HTTP, Bearer paste) — no bespoke REST clients',
      'A hand-written REST client per provider',
      'A LangChain tool wrapper',
      'A server-side cron that syncs their data into Mongo',
    ],
    answer: 0,
    explain:
      'The catalog + MCP client is the extension surface; a first-class REST client would be glue code the connector system obsoletes.',
  },
  {
    id: 'c02',
    category: 'Connectors',
    q: 'What auth does the Things To Do connector use to connect?',
    options: [
      'mcp.pat — a Bearer-pasted API key (required; the endpoint reads and validates the Authorization header)',
      'Keyless — the endpoint is open',
      'OAuth 2.0 browser redirect',
      'Basic auth with username/password',
    ],
    answer: 0,
    explain:
      "A dummy Bearer key gets a 401 from the MCP endpoint — it validates the header, which is exactly Tova's Bearer-wrapped PAT paste flow.",
  },
  {
    id: 'c03',
    category: 'Connectors',
    q: 'A user pastes "Authorization: Bearer KEY" into a connector token field. What happens?',
    options: [
      'The ingest strips the authorization: prefix and any bearer scheme, then wraps the key — scheme-only pastes are rejected 400 ("paste the key only")',
      'It is stored verbatim, producing Bearer Bearer … headers',
      'It is rejected as invalid JSON',
      'It works — the provider tolerates doubled headers',
    ],
    answer: 0,
    explain:
      'Two real paste traps (bare scheme, whole header) drove the hardening; boundary-safe — "bearerly-key"-style tokens are untouched.',
  },
  {
    id: 'c04',
    category: 'Connectors',
    q: "What does the connector instructions flow do when an entry's instructionsRef can't be resolved?",
    options: [
      'Falls back to generic copy — never a crash or an empty modal',
      'Hides the connector from the grid',
      'Throws a 500 on the connectors route',
      'Renders the raw ref string',
    ],
    answer: 0,
    explain:
      'instructionsFor resolves catalog entries to setup copy; an unresolvable ref degrades to generic instructions.',
  },
  {
    id: 'c05',
    category: 'Connectors',
    q: "Why can't MCP server tokens be hashed like passwords?",
    options: [
      'Tokens must be replayed verbatim in request headers — bcrypt is one-way, so the encrypted headers envelope is required',
      'Because bcrypt has a 72-byte limit',
      'Because Mongo forbids bcrypt fields',
      'They are hashed — the question is wrong',
    ],
    answer: 0,
    explain:
      'The schema takes authToken (strictObject rejects the old authHeader shape) and the server wraps it into the encrypted headers envelope as Authorization: Bearer at call time.',
  },

  // ── Bootstrap & background ───────────────────────────────────────
  {
    id: 'b01',
    category: 'Bootstrap & background',
    q: 'What does the process-level safety net do with an uncaughtException?',
    options: [
      'Exits (process.exit(1)) — except errors from tesseract.js workers, which are contained and logged',
      'Always logs and continues',
      'Restarts the server in-process',
      'Forwards the error to the client and keeps serving',
    ],
    answer: 0,
    explain:
      'index.ts installProcessSafetyNet: fail-fast on uncaught exceptions, with a stack-shaped carve-out so one OCR worker cannot take the process down (its blast radius is a single call).',
  },
  {
    id: 'b02',
    category: 'Bootstrap & background',
    q: 'What happens to an unhandled promise rejection under the safety net?',
    options: [
      'It is logged (redacted) and the process keeps running',
      'It exits the process like an uncaught exception',
      'It is silently swallowed',
      'It is persisted to a dead-letter collection',
    ],
    answer: 0,
    explain:
      'unhandledRejection logs with redactForLog; only uncaughtException exits — the two signals have deliberately different blast radii.',
  },
  {
    id: 'b03',
    category: 'Bootstrap & background',
    q: 'Which set of background workers starts only when NOT running tests?',
    options: [
      'Asset job poller, task poller, eval scheduler, trace stats poller, asset version pruner, pending-asset sweeper',
      'Only the task poller',
      'The Mongo change streams',
      'The SSE heartbeat',
    ],
    answer: 0,
    explain:
      'index.ts startServer gates the poller cluster behind the non-test check so suite runs never spawn timers or touch providers.',
  },
  {
    id: 'b04',
    category: 'Bootstrap & background',
    q: 'What is the default state of the scheduled eval runner?',
    options: [
      'Off — it only runs when TOVA_EVAL_SCHEDULE=daily, firing once at TOVA_EVAL_HOUR_UTC',
      'On by default, hourly',
      'On by default, daily at midnight UTC',
      'Triggered by every deploy',
    ],
    answer: 0,
    explain:
      'evalScheduler is default-off; scheduled memory evals also run the retrieval stage only — gate/judge stages stay off the unattended schedule.',
  },
  {
    id: 'b05',
    category: 'Bootstrap & background',
    q: 'How does the eval scheduler avoid double-running on a restart mid-day?',
    options: [
      'hasRunForUtcDay checks whether any run (any status) already exists for the current UTC day',
      'A file lock in /tmp',
      'The cron daemon dedupes',
      'It does not — restarts always re-run',
    ],
    answer: 0,
    explain:
      'The check spans the UTC day boundaries, any status — a failed run still counts as "ran today".',
  },
  {
    id: 'b06',
    category: 'Bootstrap & background',
    q: 'What bounds the number of unconfirmed (pending) presign uploads per user?',
    options: [
      'A per-user cap of 40 live pending rows; a sweeper reclaims stale ones',
      'No cap — presigns are cheap',
      'A global server cap of 500',
      'One pending upload at a time',
    ],
    answer: 0,
    explain:
      'assetPresign: MAX_PENDING_ASSETS 40 per user with a pending TTL (2× the confirm window), plus a pending-asset sweeper poller — unconfirmed presigns cannot pool up.',
  },
];
