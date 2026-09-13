import { buildSystemContent, resolveSystemPrompt } from './promptAssembly';
import { UserDocument } from '../models/User';

const userWith = (fields: Partial<Pick<UserDocument, 'name' | 'preferredName' | 'settings'>>) =>
  fields as Pick<UserDocument, 'name' | 'preferredName' | 'settings'>;

describe('resolveSystemPrompt', () => {
  it('returns the global fallback for null user', () => {
    expect(resolveSystemPrompt(null)).toMatch(/^You are Tova/);
  });

  it('uses the per-user prompt when set', () => {
    const user = userWith({ settings: { systemPrompt: 'Be terse.' } });
    expect(resolveSystemPrompt(user)).toBe('Be terse.');
  });

  it('falls back to the global prompt for whitespace-only settings', () => {
    const user = userWith({ settings: { systemPrompt: '   \n  ' } });
    expect(resolveSystemPrompt(user)).toMatch(/^You are Tova/);
  });

  it('falls back when settings is null', () => {
    expect(resolveSystemPrompt(userWith({}))).toMatch(/^You are Tova/);
  });
});

describe('buildSystemContent / profile-context block (issue #35)', () => {
  it('appends the preferred-name line when set', () => {
    const content = buildSystemContent(userWith({ preferredName: 'Alex', name: 'Alexandra Moon' }));
    expect(content).toContain('The user goes by "Alex".');
    expect(content).toContain('full name is Alexandra Moon');
    expect(content).toContain('never address them by it');
    expect(content).toContain('Profile details are context');
  });

  it('includes the full-name instruction when no preferred name exists', () => {
    const content = buildSystemContent(userWith({ name: 'Ada Lovelace' }));
    expect(content).toContain('full name is Ada Lovelace');
    expect(content).toContain('invite them to set a preferred name');
    expect(content).not.toContain('goes by');
  });

  it('stays byte-identical to the resolved prompt when no profile data exists', () => {
    const resolved = resolveSystemPrompt(userWith({}));
    expect(buildSystemContent(userWith({}))).toBe(resolved);
    expect(buildSystemContent(null)).toBe(resolved);
  });

  it('never includes the relevance instruction alone without any profile data', () => {
    const content = buildSystemContent(userWith({ settings: { systemPrompt: 'Custom.' } }));
    expect(content).toBe('Custom.');
  });
});
