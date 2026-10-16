// Issue #145: shared redaction for log emission. Chat-route errors and
// extraction/classification failures can embed prompt content or extracted
// user text (e.g. a provider error echoing the request body). There is no
// central choke point — logService.attachConsoleCapture() mirrors console.*
// verbatim into the admin buffer — so call sites must redact before they
// pass anything risky to console.*.

// Policy note: this is the conservative heuristic (option b, plan-145).
// It targets long/high-entropy segments, quoted request bodies, and JSON
// blocks; short message tokens (status codes, errno classes) and quoted
// filesystem paths survive. Paths are code-controlled (fs error messages
// quote the exact file), and the #358 diagnosis was slowed by redacting
// them, so the quoted-string rules carve them out — narrowly: POSIX-safe
// charset, no scheme, short extension-terminated final segment. URLs and
// token-ish runs still redact, and any 64+-char run is re-caught by the
// long-run rules regardless. Whether the result is sufficient for short
// personal content is an open audit question — see
// docs/done/plan-145-log-redaction.md.

export const REDACTED = '[redacted]';

const MAX_STACK = 2000;

interface NonError {
  name?: string;
  message?: string;
  stack?: string;
  code?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// A filesystem path as quoted in fs error messages (`open '/app/x/y.gz'`,
// `readFile 'dist/main.js'`) and code-controlled logs. Deliberately narrow —
// this is an allowlist inside an over-redaction-first heuristic:
// - POSIX-safe charset only (no spaces, quotes, shell metacharacters);
// - no scheme separator, so URLs (which can embed tokens or user text) never
//   match;
// - the final segment must carry a short (1-16 char) file extension, so
//   opaque runs like `/reset/<token>` or `/p/<id>` still redact. Real paths
//   virtually always end in a file; extension-less directory paths stay
//   redacted (conservative miss, accepted);
// - bounded at 64 chars, aligned with the long-run backstop rules below:
//   pathological "paths" longer than that stay redacted (plan-145
//   conservative direction). Real fs error paths are well under this.
const PATH_SAFE_CHARS = /^[\w./@+~-]+$/;
const FILE_EXTENSION_END = /\.[A-Za-z0-9]{1,16}$/;
const PATH_MAX_CHARS = 64;

const isPathShaped = (text: string): boolean =>
  text.length > 0 &&
  text.length <= PATH_MAX_CHARS &&
  !text.includes('://') &&
  PATH_SAFE_CHARS.test(text) &&
  FILE_EXTENSION_END.test(text);

// Extraction for the carve-out: a quoted segment (either quote style; the
// apostrophe-pair risk is neutralised by isPathShaped's strictness — prose
// between two apostrophes never looks like a path) whose content is
// path-shaped is swapped for a placeholder that survives every rule below,
// then restored verbatim at the end. #358: without this, the final catch-all
// redacts the ENTIRE fs error message once the path is kept (the message is
// one long line), which is worse than redacting just the path.
const QUOTED_SEGMENT = /'((?:\\.|[^']){1,300})'|"((?:\\.|[^"]){1,300})"/g;
const PATH_PLACEHOLDER = (i: number): string => `\u0000${i}\u0000`;

/**
 * Redact user-shaped content from a single string: quoted strings that are
 * long enough to be payload text, JSON-esque blocks, and long token
 * sequences without spaces (high-entropy fragments, embedded bodies).
 */
export const redactString = (text: string): string => {
  if (!text) return text;
  const paths: string[] = [];
  let out = text.replace(
    QUOTED_SEGMENT,
    (quoted, sq: string | undefined, dq: string | undefined) => {
      if (!isPathShaped(sq ?? dq ?? '')) return quoted;
      paths.push(quoted);
      return PATH_PLACEHOLDER(paths.length - 1);
    },
  );
  // JSON-ish objects/arrays spanning >= 40 chars (includes quoted request
  // bodies embedded by provider errors via stringify)
  out = out.replace(/[{[][\s\S]{40,}[}\]]/g, REDACTED);
  // Double-quoted payload text (>= 16 chars) — covers embedded prompt
  // fragments in single-line provider messages
  out = out.replace(/"((?:\\.|[^"]){16,})"/g, `"${REDACTED}"`);
  // Single-quoted payload text, but only when the opening quote is not a
  // word-internal apostrophe: contractions/possessives ("doesn't", "user's")
  // would otherwise be matched as pairs and corrupt ordinary prose.
  out = out.replace(/(?<![\w'])'((?:\\.|[^']){16,})'/g, `'${REDACTED}'`);
  // Secret-shaped assignments (apikey=..., bearer token=...) — short values
  // survive the whitespace-free threshold, so they need a dedicated rule.
  out = out.replace(
    /((?:api[_-]?key|token|secret|password|authorization|bearer)["'\s:=]+\s*)(["']?)[\w./+-]{8,}\2/gi,
    `$1$2${REDACTED}$2`,
  );
  // Long whitespace-free runs — UUIDs/b64/keys/system dumps
  out = out.replace(/[^\s'"{}[\]]{64,}/g, REDACTED);
  // Catch-all: any remaining single-line run of >= 64 chars is treated as
  // embedded prose (provider echo of prompt text). Deliberately aggressive:
  // the conservative direction is over-redaction (plan-145 open question).
  out = out.replace(/[^\n\r]{64,}/g, REDACTED);
  // eslint-disable-next-line no-control-regex -- the \x00 sentinel is the point
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => {
    const path = paths[Number(i)];
    return path === undefined ? '' : path;
  });
};

/** Serialize an unknown value to inspectable text without throwing. */
const serialize = (value: unknown) => {
  try {
    return JSON.stringify(value, (_key, v) => (isRecord(v) ? v : String(v)), 2) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
};

const redactErrorBody = (body: NonError): string => {
  const parts: string[] = [];
  if (body.name) parts.push(body.name);
  if (typeof body.message === 'string') {
    const msg = redactString(body.message);
    if (msg) parts.push(msg);
  } else if (body.message) {
    parts.push(redactString(serialize(body.message)));
  }
  if (typeof body.stack === 'string') {
    // Stack frames are code-controlled (paths + line numbers); keep
    // verbatim except for the mirrored message already redacted above.
    // Clip the whole path anyway: raw stack text can embed message text
    // in the first line, which the message-level pass may have missed.
    const firstNewline = body.stack.indexOf('\n');
    if (firstNewline !== -1) {
      const frames = body.stack
        .slice(firstNewline + 1)
        .slice(0, MAX_STACK)
        .trimEnd();
      if (frames) parts.push(`\n${frames}`);
    }
  }
  if (body.code) parts.push(`code: ${body.code}`);
  return parts.join(': ');
};

/**
 * Format an unknown argued-to-console value into a string safe for
 * console.error: message text redacted, error shape (name, frames, short
 * status/class tokens) kept.
 */
export const redactForLog = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isRecord(value)) {
    if (value instanceof Error || (typeof value.stack === 'string' && 'message' in value)) {
      return redactErrorBody(value as NonError);
    }
    return redactString(serialize(value));
  }
  return redactString(String(value));
};
