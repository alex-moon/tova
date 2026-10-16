import mammoth from 'mammoth';
import turndown from 'turndown';
import { PDFParse } from 'pdf-parse';

// Markdown conversion (issue #67): JS-native toolchain (mammoth for docx,
// pdf-parse — pdf.js — for PDF, turndown for HTML) instead of a markitdown
// Python subprocess: no new runtime, sidecar or queue infra. Conversion is
// deterministic-failfile: unknown extensions and empty results throw so the
// job loop retries/fails with a reason. Extension decided from the filename
// like textExtraction (#34), not the client-provided contentType.

export const CONVERTIBLE_EXTENSIONS = new Set(['pdf', 'docx', 'html', 'htm']);

// Storage cap on the persisted markdown (issue #67): conversion output is
// trimmed at store time; the 12k prompt cap applies at use time, so a large
// document still contributes its head to search/attach.
export const MAX_MARKDOWN_CHARS = 200_000;

// Hard ceiling per conversion attempt: a hung parser must not wedge the
// poller; the job loop treats the timeout as any other failure.
export const CONVERSION_TIMEOUT_MS = 30_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const turndownInstance = new (turndown as any)({ headingStyle: 'atx', bulletListMarker: '-' });

// HTML→markdown conversion used both by asset ingestion (rawConvert below)
// and by the `fetch_url` page fetcher (issue #113): one turndown instance,
// owned by this module.
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

// Store-time normalisation shared by every producer of `markdownExtracted`
// (issue #67 conversion, issue #209 OCR): normalise line endings, unify the
// curly apostrophe, trim, and enforce the storage cap. Exported so the OCR
// stage — which does not go through `convertToMarkdown` for images — applies
// exactly the same cap rather than duplicating it.
export const finalizeMarkdown = (raw: string): string =>
  raw
    .replace(/\r\n/g, '\n')
    .replace(/\u2019/g, "'")
    .trim()
    .slice(0, MAX_MARKDOWN_CHARS);

// Convert a document buffer to markdown. Throws on unsupported extension,
// converter error, or empty conversion output.
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
      // PDF text comes out in reading order with plain page separators
      // (`-- n of n --`); keep it verbatim rather than re-styling it.
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        return result?.text ?? '';
      } finally {
        await parser.destroy?.();
      }
    }
    case 'docx': {
      // mammoth's bundled typings miss the 'convertToMarkdown' helper.
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
