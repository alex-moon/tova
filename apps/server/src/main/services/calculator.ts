import { create, all } from 'mathjs/number';

/* The calculator behind the `calculate` tool: number-only mathjs under a lockdown + strict char allowlist + length/finite checks; pure, never throws. */
// @see #283 #263

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

// Digits, letters, whitespace, arithmetic operators, decimal points and parentheses — nothing else.
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
