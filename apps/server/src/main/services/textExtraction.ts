// Light text extraction: deterministic and fast, extension-driven.
// @see #34
import { extensionOf } from './markdownConversion';

const EXTRACTABLE_EXTENSIONS = new Set(['txt', 'md', 'csv']);

export const isExtractable = (filename: string): boolean =>
  EXTRACTABLE_EXTENSIONS.has(extensionOf(filename));

export const extractText = (filename: string, buf: Buffer): string | null => {
  if (!isExtractable(filename)) return null;
  return stripBom(buf.toString('utf8'));
};

// Cap applied at prompt-inclusion time so a huge CSV cannot blow the context.
// @see #34
export const MAX_PROMPT_TEXT_CHARS = 12_000;

export const truncateForPrompt = (text: string, max = MAX_PROMPT_TEXT_CHARS): string => {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[...truncated ${text.length - max} characters...]`;
};

const stripBom = (text: string): string => (text.startsWith('\ufeff') ? text.slice(1) : text);
