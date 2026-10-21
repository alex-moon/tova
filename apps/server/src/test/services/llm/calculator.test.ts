import { calculateTool } from '../../../main/services/llm/mastraService';
import { evaluateExpression } from '../../../main/services/llm/calculator';

describe('evaluateExpression (#283)', () => {
  it('evaluates arithmetic with correct precedence and parentheses', () => {
    expect(evaluateExpression('17 * 24 + 13')).toEqual({ result: 421 });
    expect(evaluateExpression('2 + 3 * 4')).toEqual({ result: 14 });
    expect(evaluateExpression('(2 + 3) * 4')).toEqual({ result: 20 });
    expect(evaluateExpression('0.18 * 2450 + 137')).toEqual({ result: 578 });
    expect(evaluateExpression('2^10')).toEqual({ result: 1024 });
    expect(evaluateExpression('17 % 5')).toEqual({ result: 2 });
  });

  it('supports the common numeric functions', () => {
    expect(evaluateExpression('sqrt(3^2 + 4^2)')).toEqual({ result: 5 });
    expect(evaluateExpression('round(3.14159 * 100) / 100')).toEqual({ result: 3.14 });
  });

  it('returns a plain number type, never a mathjs object', () => {
    const out = evaluateExpression('2 + 2');
    expect(typeof out.result).toBe('number');
  });

  it('never throws on malformed input — a bad expression is a graceful error', () => {
    for (const bad of [') (', '2 +', 'foo(3)', '2 3 4', '']) {
      expect(() => evaluateExpression(bad)).not.toThrow();
      expect(evaluateExpression(bad).error).toBeTruthy();
    }
  });

  it('rejects the range operator (the known mathjs DoS path)', () => {
    expect(evaluateExpression('1:999999999999999999').error).toBeTruthy();
  });

  it('rejects array/object syntax, quotes, commas and assignment', () => {
    for (const bad of ['[1, 2, 3]', '{a: 1}', 'concat("a", "b")', 'a = 5', 'max(1;2)']) {
      expect(evaluateExpression(bad).error).toBeTruthy();
    }
  });

  it('rejects over-long input', () => {
    expect(evaluateExpression(`1+${'1+'.repeat(150)}1`).error).toBeTruthy();
  });

  it('rejects non-finite results', () => {
    expect(evaluateExpression('1/0').error).toBeTruthy();
    expect(evaluateExpression('0/0').error).toBeTruthy();
  });

  it('rejects an empty or whitespace-only expression', () => {
    expect(evaluateExpression('   ').error).toBeTruthy();
  });
});

describe('calculate tool (#283)', () => {
  it('is registered under the id the prompt names', () => {
    expect((calculateTool as { id: string }).id).toBe('calculate');
  });

  it('evaluates through the tool execute', async () => {
    const execute = (
      calculateTool as unknown as {
        execute: (args: { expression: string }) => Promise<{ result?: number; error?: string }>;
      }
    ).execute;
    expect(await execute({ expression: '12 * 12' })).toEqual({ result: 144 });
    expect((await execute({ expression: '1:2' })).error).toBeTruthy();
  });
});
