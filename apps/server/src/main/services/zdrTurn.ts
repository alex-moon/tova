/* Per-turn incognito decision, one pure function; route flags, not HTTP. */
// @see #144
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
