// Shared redaction for log emission; no central choke point exists.
// @see #145
// Conservative heuristic: entropy runs, quoted bodies, JSON blocks redact.
// @see #145 #358

export const REDACTED = '[redacted]';

const MAX_STACK = 2000;

// Partial mode keeps head/tail words of long prose for context (traces).
const PARTIAL_CONTEXT_WORDS = 3;
const PARTIAL_MIN_WORDS = 12;

export interface RedactOptions {
  /** Keep first/last words of long prose; full-redact secrets regardless. */
  partial?: boolean;
}

interface NonError {
  name?: string;
  message?: string;
  stack?: string;
  code?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// fs-quoted filesystem paths: narrow allowlist so tokens still redact.
const PATH_SAFE_CHARS = /^[\w./@+~-]+$/;
const FILE_EXTENSION_END = /\.[A-Za-z0-9]{1,16}$/;
const PATH_MAX_CHARS = 64;

const isPathShaped = (text: string): boolean =>
  text.length > 0 &&
  text.length <= PATH_MAX_CHARS &&
  !text.includes('://') &&
  PATH_SAFE_CHARS.test(text) &&
  FILE_EXTENSION_END.test(text);

// Carve-out: quoted paths are restored verbatim after redaction.
// @see #358
const QUOTED_SEGMENT = /'((?:\\.|[^']){1,300})'|"((?:\\.|[^"]){1,300})"/g;
const PATH_PLACEHOLDER = (i: number): string => `\u0000${i}\u0000`;
// Literal markers in user text must not trip the partial catch-all skip.
const USER_MARKER = /\[redacted\]/g;

// Head/tail words survive with the middle blanked; full-blank when the
// match has no words to keep (whitespace-free runs) or too few to hide.
const partialRedact = (text: string): string => {
  const words = text.trim().split(/\s+/);
  if (words.length < PARTIAL_MIN_WORDS) return REDACTED;
  const head = words.slice(0, PARTIAL_CONTEXT_WORDS).join(' ');
  const tail = words.slice(-PARTIAL_CONTEXT_WORDS).join(' ');
  return `${head} ${REDACTED} ${tail}`;
};

/** Redact user-shaped content: quoted strings, JSON, token runs. */
export const redactString = (text: string, opts: RedactOptions = {}): string => {
  if (!text) return text;
  const partial = opts.partial === true;
  const softBlank = (inner: string): string => (partial ? partialRedact(inner) : REDACTED);
  const paths: string[] = [];
  let out = text
    .replace(USER_MARKER, () => {
      paths.push(REDACTED);
      return PATH_PLACEHOLDER(paths.length - 1);
    })
    .replace(QUOTED_SEGMENT, (quoted, sq: string | undefined, dq: string | undefined) => {
      if (!isPathShaped(sq ?? dq ?? '')) return quoted;
      paths.push(quoted);
      return PATH_PLACEHOLDER(paths.length - 1);
    });
  // JSON-ish objects/arrays >= 40 chars (embedded request bodies); may
  // carry keys, so partial mode still blanks them wholesale.
  out = out.replace(/[{[][\s\S]{40,}[}\]]/g, REDACTED);
  // Double-quoted payload text (>= 16 chars): prompt fragments.
  out = out.replace(/"((?:\\.|[^"]){16,})"/g, (_, inner: string) => `"${softBlank(inner)}"`);
  // Single-quoted payload text; word-internal apostrophes survive.
  out = out.replace(
    /(?<![\w'])'((?:\\.|[^']){16,})'/g,
    (_, inner: string) => `'${softBlank(inner)}'`,
  );
  // Secret-shaped assignments; short values need a dedicated rule.
  out = out.replace(
    /((?:api[_-]?key|token|secret|password|authorization|bearer)["'\s:=]+\s*)(["']?)[\w./+-]{8,}\2/gi,
    `$1$2${REDACTED}$2`,
  );
  // Long whitespace-free runs — UUIDs/b64/keys/system dumps; no words to keep.
  out = out.replace(/[^\s'"{}[\]]{64,}/g, REDACTED);
  // Catch-all: any remaining >= 64-char run; partial keeps head/tail words.
  // A run carrying a machine marker was decided by an earlier rule — the
  // backstop must not blank the context it kept; user-typed markers are
  // stashed above and cannot trigger the skip. @see #383
  out = out.replace(/[^\n\r]{64,}/g, (run) => {
    if (!partial) return REDACTED;
    return run.includes(REDACTED) ? run : partialRedact(run);
  });
  // eslint-disable-next-line no-control-regex -- sentinel is the point
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
    // Stack frames are code-controlled; keep verbatim, clipped.
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

/** Format an unknown value into a string safe for console.error. */
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
