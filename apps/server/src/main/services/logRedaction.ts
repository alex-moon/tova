// Shared redaction for log emission; no central choke point exists.
// @see #145
// Conservative heuristic: entropy runs, quoted bodies, JSON blocks redact.
// @see #145 #358

export const REDACTED = '[redacted]';

const MAX_STACK = 2000;

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

/** Redact user-shaped content: quoted strings, JSON, token runs. */
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
  // JSON-ish objects/arrays >= 40 chars (embedded request bodies).
  out = out.replace(/[{[][\s\S]{40,}[}\]]/g, REDACTED);
  // Double-quoted payload text (>= 16 chars): prompt fragments.
  out = out.replace(/"((?:\\.|[^"]){16,})"/g, `"${REDACTED}"`);
  // Single-quoted payload text; word-internal apostrophes survive.
  out = out.replace(/(?<![\w'])'((?:\\.|[^']){16,})'/g, `'${REDACTED}'`);
  // Secret-shaped assignments; short values need a dedicated rule.
  out = out.replace(
    /((?:api[_-]?key|token|secret|password|authorization|bearer)["'\s:=]+\s*)(["']?)[\w./+-]{8,}\2/gi,
    `$1$2${REDACTED}$2`,
  );
  // Long whitespace-free runs — UUIDs/b64/keys/system dumps.
  out = out.replace(/[^\s'"{}[\]]{64,}/g, REDACTED);
  // Catch-all: any remaining >= 64-char run; over-redaction is safe.
  out = out.replace(/[^\n\r]{64,}/g, REDACTED);
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
