import { create, all } from 'mathjs/number';

/*
 * #283 (follow-up to #263): the calculator behind the built-in `calculate` tool.
 *
 * Arithmetic is not something an LLM should do from its weights — multi-digit
 * products, percentages and multi-step sums go wrong quietly. This module wraps
 * the number-only mathjs build (`mathjs/number`; the old `mathjs-expression-parser`
 * package is deprecated and redirects here) so the model can get an exact result.
 *
 * The expression is model-generated, which makes it semi-untrusted: a file the
 * model reads, or the user's own message, can steer it. mathjs's expression
 * parser has a rough security history (prototype-pollution/RCE CVEs; a known
 * process-crashing range DoS), so this is locked down three ways:
 *
 *   1. the documented `limitedEvaluate` lockdown — the functions that widen the
 *      attack surface (`import`, `createUnit`, `reviver`, `evaluate`, `parse`,
 *      `simplify`, `derivative`, `resolve`) throw if an expression reaches them;
 *   2. a strict character allowlist that admits only arithmetic, so the range
 *      operator `:` (the DoS), array/object syntax, quotes and assignment `=`
 *      are unreachable;
 *   3. a length cap and a finite-number result check.
 *
 * The function is pure and never throws — a bad expression is a graceful
 * `{ error }`, never a failed turn.
 */

const math = create(all);
const limitedEvaluate = math.evaluate;
math.import(
  {
    import: () => {
      throw new Error('Function import is disabled');
    },
    createUnit: () => {
      throw new Error('Function createUnit is disabled');
    },
    reviver: () => {
      throw new Error('Function reviver is disabled');
    },
    evaluate: () => {
      throw new Error('Function evaluate is disabled');
    },
    parse: () => {
      throw new Error('Function parse is disabled');
    },
    simplify: () => {
      throw new Error('Function simplify is disabled');
    },
    derivative: () => {
      throw new Error('Function derivative is disabled');
    },
    resolve: () => {
      throw new Error('Function resolve is disabled');
    },
  },
  { override: true },
);

// Digits, letters (function and constant names), whitespace, the arithmetic
// operators, decimal points and parentheses — nothing else.
const ALLOWED_CHARS = /^[0-9a-zA-Z\s+\-*/%^().]+$/;
const MAX_LENGTH = 200;

export interface CalcResult {
  result?: number;
  error?: string;
}

export const evaluateExpression = (raw: string): CalcResult => {
  const expression = raw.trim();
  if (!expression) return { error: 'No expression to evaluate.' };
  if (expression.length > MAX_LENGTH) return { error: 'Expression is too long.' };
  if (!ALLOWED_CHARS.test(expression)) {
    return { error: 'Only plain arithmetic is supported.' };
  }
  try {
    const value = limitedEvaluate(expression);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { error: 'Expression did not evaluate to a finite number.' };
    }
    return { result: value };
  } catch {
    return { error: 'Could not evaluate that expression.' };
  }
};
