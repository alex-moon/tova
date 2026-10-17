// Memory-eval corpus types: a hand-labelled gate set plus scenarios driving retrieval and helpfulness.
// @see #289 #112

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
  /** Soft-deleted chat seed: materialised, then excluded by `deletedAt` (chat-only flag). */
  deleted?: boolean;
}

/** Scenario categories, so the baseline report shows where retrieval fails. */
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
  /** Whether the baseline is expected to surface it; false documents a known miss by construction. */
  // @see #293
  expectSurfaced: boolean;
  /** Deterministic substring a helpful answer must contain (stage-3 backbone). */
  expectedFact: string;
  /** Filler messages burying the seed beyond the old bounded pool (`out-of-pool` only). */
  // @see #293
  poolFill?: number;
}

/** How a positive turn refers back, so recall can be reported per subtype. */
export type GateSubtype = 'explicit' | 'continuation' | 'bare-deixis';

/** One hand-labelled gate case: does this turn refer back to the user's past work? */
export interface GateCase {
  id: string;
  prompt: string;
  /** Prior turns, when the refer-back signal lives in a continuation. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** Hand label: true = the workspace gate should fire. */
  refersBack: boolean;
  /** Refer-back subtype; set on every positive, absent on negatives. */
  subtype?: GateSubtype;
  note?: string;
}
