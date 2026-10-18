export const MAX_STORED_ERROR_CHARS = 500;

/* Stored error text is capped; longer messages lose their tail. */
export const clampError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_STORED_ERROR_CHARS);
};
