import mammoth from 'mammoth';
import turndown from 'turndown';
import { PDFParse } from 'pdf-parse';

// Markdown conversion: JS-native toolchain instead of a Python subprocess.
// @see #67 #34

export const CONVERTIBLE_EXTENSIONS = new Set(['pdf', 'docx', 'html', 'htm']);

// Storage cap on the persisted markdown, applied at store time.
// @see #67
export const MAX_MARKDOWN_CHARS = 200_000;

// Per-attempt ceiling: a hung parser must not wedge the poller.
export const CONVERSION_TIMEOUT_MS = 30_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const turndownInstance = new (turndown as any)({ headingStyle: 'atx', bulletListMarker: '-' });

// Shared by asset ingestion and the fetch_url fetcher: one owned instance.
// @see #113
export const htmlToMarkdown = (html: string): string => turndownInstance.turndown(html);

export const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
};

export const isConvertible = (filename: string): boolean =>
  CONVERTIBLE_EXTENSIONS.has(extensionOf(filename));

export const withTimeout = <T>(promise: Promise<T>, ms = CONVERSION_TIMEOUT_MS): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`conversion timed out after ${ms}ms`)), ms);
      // Keep the process from being held open by an orphaned timer (tests).
      t.unref?.();
    }),
  ]);

// Store-time normalisation shared by every producer of markdownExtracted.
// @see #67 #209
export const finalizeMarkdown = (raw: string): string =>
  raw
    .replace(/\r\n/g, '\n')
    .replace(/\u2019/g, "'")
    .trim()
    .slice(0, MAX_MARKDOWN_CHARS);

// Converts a document buffer to markdown; throws on failure or empty output.
export const convertToMarkdown = async (
  filename: string,
  buffer: Buffer,
  timeoutMs = CONVERSION_TIMEOUT_MS,
): Promise<string> => {
  const ext = extensionOf(filename);
  if (!CONVERTIBLE_EXTENSIONS.has(ext)) {
    throw new Error(`unsupported conversion type: .${ext || '(none)'}`);
  }

  const raw = await withTimeout(rawConvert(ext, buffer), timeoutMs);
  if (raw == null) {
    throw new Error(`conversion produced no text for .${ext}`);
  }
  const markdown = finalizeMarkdown(raw);
  if (markdown.length === 0) {
    throw new Error(`conversion produced empty markdown for .${ext}`);
  }
  return markdown;
};

const rawConvert = async (ext: string, buffer: Buffer): Promise<string | null | undefined> => {
  switch (ext) {
    case 'pdf': {
      // PDF text comes out in reading order; keep it verbatim.
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        return result?.text ?? '';
      } finally {
        await parser.destroy?.();
      }
    }
    case 'docx': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const converter = mammoth as any as {
        convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string }>;
      };
      return converter.convertToMarkdown({ buffer }).then((r) => r.value);
    }
    case 'html':
    case 'htm':
      return htmlToMarkdown(buffer.toString('utf8'));
    default:
      throw new Error(`unsupported conversion type: .${ext}`);
  }
};
