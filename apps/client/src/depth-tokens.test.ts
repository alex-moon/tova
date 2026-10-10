import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Atmospheric depth (issue #191) is a token layer in index.css: the wash, the
// panel solidity gradient and the edge glow all derive per theme from the
// --c-* primitives. These tests parse the real stylesheet so a stray raw hex in
// a depth token, or a token dropped from one theme, fails loudly.

const CSS = readFileSync(
  new URL(import.meta.url).pathname.replace(/depth-tokens\.test\.ts$/, './index.css'),
  'utf8',
);

/** Extract the body of the first rule whose selector list contains `selector`. */
const blockFor = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*[^{}]*${escaped}[^{}]*\\{([\\s\\S]*?)\\n\\}`).exec(CSS);
  if (!match) throw new Error(`rule not found for selector: ${selector}`);
  return match[1];
};

/** The value of a custom property, from its name to the terminating semicolon. */
const declarationsFor = (css: string, token: string): string[] => {
  const pattern = new RegExp(`${token.replace(/[-]/g, '\\-')}\\s*:([\\s\\S]*?);`, 'g');
  return [...css.matchAll(pattern)].map((match) => match[1]);
};

const depthTokens = ['--c-wash', '--c-panel-surface', '--c-edge-glow'] as const;

describe('depth tokens (index.css, issue #191)', () => {
  it('defines the intensity knobs at the subtle default of 1', () => {
    const theme = blockFor('@theme');
    expect(theme).toMatch(/--wash-strength:\s*1;/);
    expect(theme).toMatch(/--edge-glow-strength:\s*1;/);
  });

  it.each(depthTokens)('defines %s in both light (:root) and dark (.dark)', (token) => {
    expect(blockFor(':root')).toContain(`${token}:`);
    expect(blockFor('.dark')).toContain(`${token}:`);
  });

  it.each(depthTokens)('%s is token-driven, not a raw hex', (token) => {
    const css = `${blockFor(':root')}\n${blockFor('.dark')}`;
    const declarations = declarationsFor(css, token);
    expect(declarations.length).toBeGreaterThanOrEqual(2);
    for (const declaration of declarations) {
      expect(declaration).toContain('var(--c-');
      expect(declaration).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it('keeps the base 1px border token in both themes (glow is additive)', () => {
    expect(blockFor(':root')).toMatch(/--c-border:\s*#[0-9a-fA-F]{3,8};/);
    expect(blockFor('.dark')).toMatch(/--c-border:\s*#[0-9a-fA-F]{3,8};/);
  });
});
