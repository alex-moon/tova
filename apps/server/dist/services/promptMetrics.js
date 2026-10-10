"use strict";
/**
 * Pure per-message prompt metrics. No deps, no I/O, no LLM.
 *
 * These are cheap deterministic proxies collected so routing decisions and
 * future feedback can be correlated with prompt characteristics. The
 * heuristics (syllable vowel-cluster estimate, English stopword list,
 * imperative first word) are English-only by design; the syllable estimate
 * in particular is meaningless for CJK and other scripts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeDeterministicMetrics = exports.computeCodeIndicators = exports.computeLengthBucket = exports.hasImperative = exports.hasQuestionMark = exports.computeStopwordRatio = exports.estimateSyllablesAvg = exports.estimateAvgWordLength = exports.countInlineBacktickPairs = exports.countCodeFences = exports.countCodeTokens = exports.countWords = void 0;
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
const STOPWORDS = new Set([
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
const CODE_TOKEN_RE = /\b(function|const|let|var|return|class|import|export|from|def|lambda|elif|async|await|null|undefined)\b|=>|\{\}|\[\]|\(\)|<\/?[a-z]+>/g;
const WORDS_RE = /[\p{L}\p{N}']+/gu;
const countWords = (text) => {
    if (!text)
        return 0;
    return (text.match(new RegExp(WORDS_RE.source, WORDS_RE.flags)) || []).length;
};
exports.countWords = countWords;
const countCodeTokens = (text) => {
    if (!text)
        return 0;
    const m = text.match(new RegExp(CODE_TOKEN_RE.source, CODE_TOKEN_RE.flags));
    return m ? m.length : 0;
};
exports.countCodeTokens = countCodeTokens;
const countCodeFences = (text) => {
    if (!text)
        return 0;
    return (text.match(/```/g) || []).length;
};
exports.countCodeFences = countCodeFences;
// Count of standalone (non-fence) backtick pairs, e.g. `inline code`.
const countInlineBacktickPairs = (text) => {
    if (!text)
        return 0;
    const withoutFences = text.replace(/```[\s\S]*?(?:```|$)/g, '');
    return (withoutFences.match(/`[^`\n]+`/g) || []).length;
};
exports.countInlineBacktickPairs = countInlineBacktickPairs;
const countSyllables = (word) => {
    const lower = word.toLowerCase();
    const groups = lower.match(/[aeiouy]+/g);
    if (!groups)
        return lower ? 1 : 0;
    let count = groups.length;
    if (lower.endsWith('e') && count > 1)
        count -= 1;
    return Math.max(count, 1);
};
const estimateAvgWordLength = (text) => {
    const words = text ? text.match(new RegExp(WORDS_RE.source, WORDS_RE.flags)) : null;
    if (!words || words.length === 0)
        return 0;
    const total = words.reduce((sum, w) => sum + w.length, 0);
    return total / words.length;
};
exports.estimateAvgWordLength = estimateAvgWordLength;
// Average syllable count per word; 0 when there are no words.
const estimateSyllablesAvg = (text) => {
    const words = text ? text.match(new RegExp(WORDS_RE.source, WORDS_RE.flags)) : null;
    if (!words || words.length === 0)
        return 0;
    const total = words.reduce((sum, w) => sum + countSyllables(w), 0);
    return total / words.length;
};
exports.estimateSyllablesAvg = estimateSyllablesAvg;
const computeStopwordRatio = (text) => {
    const words = text ? text.match(new RegExp(WORDS_RE.source, WORDS_RE.flags)) : null;
    if (!words || words.length === 0)
        return 0;
    const stops = words.filter((w) => STOPWORDS.has(w.toLowerCase()));
    return stops.length / words.length;
};
exports.computeStopwordRatio = computeStopwordRatio;
const hasQuestionMark = (text) => /\?/.test(text || '');
exports.hasQuestionMark = hasQuestionMark;
const hasImperative = (text) => {
    const words = text ? text.match(new RegExp(WORDS_RE.source, WORDS_RE.flags)) : null;
    if (!words || words.length === 0)
        return false;
    return IMPERATIVE_VERBS.has(words[0].toLowerCase());
};
exports.hasImperative = hasImperative;
const computeLengthBucket = (wordCount) => {
    if (wordCount <= SHORT_MAX_WORDS)
        return 'short';
    if (wordCount >= LONG_MIN_WORDS)
        return 'long';
    return 'medium';
};
exports.computeLengthBucket = computeLengthBucket;
const computeCodeIndicators = (text) => ({
    fences: (0, exports.countCodeFences)(text),
    backticks: (0, exports.countInlineBacktickPairs)(text),
    codeTokenCount: (0, exports.countCodeTokens)(text),
});
exports.computeCodeIndicators = computeCodeIndicators;
const computeDeterministicMetrics = (text) => {
    const wordCount = (0, exports.countWords)(text);
    return {
        wordCount,
        charCount: (text || '').length,
        lengthBucket: (0, exports.computeLengthBucket)(wordCount),
        avgWordLength: (0, exports.estimateAvgWordLength)(text),
        syllableEstimateAvg: (0, exports.estimateSyllablesAvg)(text),
        codeIndicators: (0, exports.computeCodeIndicators)(text),
        stopwordRatio: (0, exports.computeStopwordRatio)(text),
        hasQuestionMark: (0, exports.hasQuestionMark)(text),
        hasImperative: (0, exports.hasImperative)(text),
    };
};
exports.computeDeterministicMetrics = computeDeterministicMetrics;
