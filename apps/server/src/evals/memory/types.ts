/*
 * #289 memory-eval corpus types. The three gate-eval stages share one corpus:
 * a hand-labelled gate set (does a turn refer back?) and a set of scenarios
 * (seed slices + a query) that drive both retrieval hit-rate (stage 2, by slice
 * ID) and injection helpfulness (stage 3, by expected fact + the judge pair).
 *
 * Kept separate from the #112 tool-use `evals/types.ts`: those assertions grade
 * a raw connector run; these describe a seeded workspace and a retrieval/gate
 * question, which the tool-use graders cannot express.
 */

/** The three workspace-memory corpus kinds retrieval reads. */
export type SeedKind = 'chat' | 'file' | 'task';

/** A known piece of work materialised in Mongo for one scenario. */
export interface MemorySeed {
  /** Stable synthetic id, unique within a scenario; hit-rate matches on this. */
  id: string;
  kind: SeedKind;
  title: string;
  /** Content carrying the fact a query should retrieve. */
  text: string;
  /** ISO date. Recency is a tiebreak only, but keeps fixtures deterministic. */
  at: string;
  /**
   * Soft-deleted chat seed: materialised, then excluded from the corpus by
   * `deletedAt` (a `chat`-only flag; file/task seeds ignore it).
   */
  deleted?: boolean;
}

/**
 * Scenario shape, so the baseline report shows *where* retrieval fails rather
 * than a single hit-rate: a direct query, a paraphrase with no shared content
 * words, a file, a task (#298), a soft-deleted seed, and a seed buried beyond
 * the bounded pool.
 */
export type ScenarioCategory =
  'direct' | 'paraphrase' | 'file' | 'task' | 'deleted-seed' | 'out-of-pool';

/** A seeded retrieval scenario, reused by stages 2 (hit-rate) and 3 (helpfulness). */
export interface MemoryScenario {
  id: string;
  description: string;
  category: ScenarioCategory;
  seeds: MemorySeed[];
  query: string;
  /** Seed id a correct retrieval must surface. */
  expectedSliceId: string;
  /**
   * Whether the baseline is expected to surface it. `false` documents a known
   * miss by construction (deleted seed, out-of-pool seed) so #293/#294 can show
   * the delta when they land.
   */
  expectSurfaced: boolean;
  /** Deterministic substring a helpful answer must contain (stage-3 backbone). */
  expectedFact: string;
  /**
   * Filler user messages to bury the seed beyond `MESSAGE_POOL`, for the
   * `out-of-pool` category. Absent/0 for every other category.
   */
  poolFill?: number;
}

/** One hand-labelled gate case: does this turn refer back to the user's past work? */
export interface GateCase {
  id: string;
  prompt: string;
  /** Prior turns, when the refer-back signal lives in a continuation. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** Hand label: true = the workspace gate should fire. */
  refersBack: boolean;
  note?: string;
}
