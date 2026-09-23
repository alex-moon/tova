/*
 * Per-turn incognito decision (#144): one pure function owns the rule that
 * both chat routes used to duplicate inline. `incognito` is the effective
 * per-chat flag: for a new chat it is the request's `zdr` intent (the chat
 * toggle, wire name unchanged) or the account's 'incognito by default'
 * (`settings.zdr` at rest); for a continuation it comes from the stored
 * `Session.incognito`.
 *
 * Semantics flagged by the route, not HTTP-shaped decisions:
 * - reject: the turn cannot be served at all (incognito turn joining a
 *   persisted chat would contradict the retention promise).
 * - persistWithHistoryReplay: persistence is suppressed; continuity comes
 *   from the client's replayed `history` payload instead of a session read.
 * - requireEphemeralCleanup: attach any asset cleanup to every exit path.
 * History validation and response payloads stay in the route.
 */
export type ZdrTurnInput = {
  incognito: boolean;
  sessionId?: string;
};

export type ZdrTurnDecision =
  | { reject: true }
  | {
      reject: false;
      persistWithHistoryReplay: boolean;
      requireEphemeralCleanup: boolean;
    };

export const decideTurn = ({ incognito, sessionId }: ZdrTurnInput): ZdrTurnDecision => {
  if (incognito && sessionId) return { reject: true };
  return {
    reject: false,
    persistWithHistoryReplay: incognito,
    requireEphemeralCleanup: incognito,
  };
};
