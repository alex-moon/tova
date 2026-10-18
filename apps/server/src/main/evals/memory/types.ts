// Memory-eval corpus types: gate set plus retrieval/helpfulness scenarios.
// @see #289 #112

/** The three workspace-memory corpus kinds retrieval reads. */
export type SeedKind = 'chat' | 'file' | 'task';

/** A known piece of work materialised in Mongo for one scenario. */
export interface MemorySeed {
  /** Stable synthetic id, unique per scenario; hit-rate keys on it. */
  id: string;
  kind: SeedKind;
  title: string;
  /** Content carrying the fact a query should retrieve. */
  text: string;
  /** ISO date. Recency is a tiebreak only; keeps fixtures fixed. */
  at: string;
  /** Soft-deleted chat seed, excluded by `deletedAt` (chat-only flag). */
  deleted?: boolean;
}

/** Scenario categories, so the baseline report shows where retrieval fails. */
export type ScenarioCategory =
  'direct' | 'paraphrase' | 'file' | 'task' | 'deleted-seed' | 'out-of-pool';

/** A seeded retrieval scenario, reused by stages 2 and 3. */
export interface MemoryScenario {
  id: string;
  description: string;
  category: ScenarioCategory;
  seeds: MemorySeed[];
  query: string;
  /** Seed id a correct retrieval must surface. */
  expectedSliceId: string;
  /** Whether the baseline should surface it; false is a known miss. */
  // @see #293
  expectSurfaced: boolean;
  /** Deterministic substring a helpful answer must contain. */
  expectedFact: string;
  /** Filler burying the seed beyond the old pool (`out-of-pool`). */
  // @see #293
  poolFill?: number;
}

/** How a positive turn refers back, so recall can be reported per subtype. */
export type GateSubtype = 'explicit' | 'continuation' | 'bare-deixis';

/** One gate case: does this turn refer back to the user's past work? */
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
