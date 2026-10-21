/** Cheap deterministic proxies for correlating routing with prompt shape. */

export interface CodeIndicators {
  fences: number;
  backticks: number;
  codeTokenCount: number;
}

export interface DeterministicMetrics {
  wordCount: number;
  charCount: number;
  lengthBucket: 'short' | 'medium' | 'long';
  avgWordLength: number;
  syllableEstimateAvg: number;
  codeIndicators: CodeIndicators;
  stopwordRatio: number;
  hasQuestionMark: boolean;
  hasImperative: boolean;
}

// Word-count thresholds for the length bucket.
const SHORT_MAX_WORDS = 12;
const LONG_MIN_WORDS = 60;

const IMPERATIVE_VERBS = new Set([
  'write',
  'make',
  'create',
  'build',
  'fix',
  'add',
  'remove',
  'delete',
  'update',
  'set',
  'run',
  'install',
  'use',
  'give',
  'show',
  'explain',
  'help',
  'do',
  'go',
  'stop',
  'start',
  'list',
  'find',
  'check',
  'test',
  'implement',
  'refactor',
  'change',
  'convert',
  'generate',
  'design',
  'review',
  'deploy',
  'configure',
  'clean',
  'read',
  'open',
  'close',
  'tell',
  'send',
  'get',
  'put',
  'try',
  'call',
  'let',
]);

const METRIC_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

const CODE_TOKEN_RE =
  /\b(function|const|let|var|return|class|import|export|from|def|lambda|elif|async|await|null|undefined)\b|=>|\{\}|\[\]|\(\)|<\/?[a-z]+>/g;

const WORDS_RE = /[\p{L}\p{N}']+/gu;

export const countWords = (text: string): number => {
  if (!text) return 0;
  return (text.match(WORDS_RE) || []).length;
};

export const countCodeTokens = (text: string): number => {
  if (!text) return 0;
  const m = text.match(CODE_TOKEN_RE);
  return m ? m.length : 0;
};

export const countCodeFences = (text: string): number => {
  if (!text) return 0;
  return (text.match(/```/g) || []).length;
};

// Count of standalone (non-fence) backtick pairs, e.g. `inline code`.
export const countInlineBacktickPairs = (text: string): number => {
  if (!text) return 0;
  const withoutFences = text.replace(/```[\s\S]*?(?:```|$)/g, '');
  return (withoutFences.match(/`[^`\n]+`/g) || []).length;
};

const countSyllables = (word: string): number => {
  const lower = word.toLowerCase();
  const groups = lower.match(/[aeiouy]+/g);
  if (!groups) return lower ? 1 : 0;
  let count = groups.length;
  if (lower.endsWith('e') && count > 1) count -= 1;
  return Math.max(count, 1);
};

export const estimateAvgWordLength = (text: string): number => {
  const words = text ? text.match(WORDS_RE) : null;
  if (!words || words.length === 0) return 0;
  const total = words.reduce((sum, w) => sum + w.length, 0);
  return total / words.length;
};

// Average syllable count per word; 0 when there are no words.
export const estimateSyllablesAvg = (text: string): number => {
  const words = text ? text.match(WORDS_RE) : null;
  if (!words || words.length === 0) return 0;
  const total = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return total / words.length;
};

export const computeStopwordRatio = (text: string): number => {
  const words = text ? text.match(WORDS_RE) : null;
  if (!words || words.length === 0) return 0;
  const stops = words.filter((w) => METRIC_STOPWORDS.has(w.toLowerCase()));
  return stops.length / words.length;
};

export const hasQuestionMark = (text: string): boolean => /\?/.test(text || '');

export const hasImperative = (text: string): boolean => {
  const words = text ? text.match(WORDS_RE) : null;
  if (!words || words.length === 0) return false;
  return IMPERATIVE_VERBS.has(words[0].toLowerCase());
};

export const computeLengthBucket = (wordCount: number): 'short' | 'medium' | 'long' => {
  if (wordCount <= SHORT_MAX_WORDS) return 'short';
  if (wordCount >= LONG_MIN_WORDS) return 'long';
  return 'medium';
};

export const computeCodeIndicators = (text: string): CodeIndicators => ({
  fences: countCodeFences(text),
  backticks: countInlineBacktickPairs(text),
  codeTokenCount: countCodeTokens(text),
});

export const computeDeterministicMetrics = (text: string): DeterministicMetrics => {
  const wordCount = countWords(text);
  return {
    wordCount,
    charCount: (text || '').length,
    lengthBucket: computeLengthBucket(wordCount),
    avgWordLength: estimateAvgWordLength(text),
    syllableEstimateAvg: estimateSyllablesAvg(text),
    codeIndicators: computeCodeIndicators(text),
    stopwordRatio: computeStopwordRatio(text),
    hasQuestionMark: hasQuestionMark(text),
    hasImperative: hasImperative(text),
  };
};
