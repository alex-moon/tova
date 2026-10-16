import {
  seedEvalSource,
  clearEvalSource,
  evalUserId,
  SUPPORT_PHONE,
  SUPPORT_PHONE_PAGE,
} from '../../main/evals/mongoSource';
import { Asset } from '../../main/models/Asset';
import { MAX_PROMPT_TEXT_CHARS, truncateForPrompt } from '../../main/services/textExtraction';

describe('#112 temp mongo source', () => {
  const userId = evalUserId.toHexString();

  it('seeds idempotently: one asset per fixture filename after repeat seeding', async () => {
    await seedEvalSource();
    await seedEvalSource();
    const files = await Asset.find({ userId });

    // Two #112 fixtures + the two #159 long-document fixtures.
    const names = files.map((f) => f.filename).sort();
    expect(names).toEqual([
      'bupa-policy.md',
      'long-manual.md',
      'project-handbook.md',
      'utilities-notes.md',
    ]);
    expect(files.every((f) => f.status === 'ready' && f.textExtracted)).toBe(true);
  });

  it('seeds the fertility-coverage fact only inside the policy file body', async () => {
    await seedEvalSource();
    const policy = await Asset.findOne({ userId, filename: 'bupa-policy.md' });
    expect(policy?.textExtracted).toContain('Fertility treatment');

    // Cross-user probes must not see the fixtures.
    expect(await Asset.countDocuments()).toBe(4);
  });

  it('seeds the #159 long manual with 60 page units, phone only on page 58', async () => {
    await seedEvalSource();
    const manual = await Asset.findOne({ userId, filename: 'long-manual.md' }).select('+units');
    const units = manual?.get('units') ?? [];
    expect(units).toHaveLength(60);
    expect(units[0].label).toBe('Page 1');
    const phonePages = (units as { index: number; text: string }[]).filter((u) =>
      u.text.includes(SUPPORT_PHONE),
    );
    expect(phonePages.map((u) => u.index)).toEqual([SUPPORT_PHONE_PAGE]);
    // Filler must be non-empty: a unit read must yield readable text.
    expect(units.every((u: { text: string }) => u.text.length > 0)).toBe(true);
    // The 120-char `unitsOnly` preview must not hand over the answer material
    // (found live: the phone sat inside page 58's preview, letting a lazy
    // `unitsOnly` read answer both case-A questions without walking units).
    expect(
      units.every((u: { text: string }) => !u.text.slice(0, 120).includes(SUPPORT_PHONE)),
    ).toBe(true);
    // The page-58 preview should still be identifiable as the support appendix
    // so the agent has a legitimate discovery path via the unit list.
    expect(units[SUPPORT_PHONE_PAGE - 1].text.slice(0, 120)).toContain('support contact');
  });

  // An agent can pass the case without paging only if the phone is visible in
  // the default head read; the filler is sized so the joined text exceeds
  // MAX_PROMPT_TEXT_CHARS and truncation cuts off before page 58.
  it('whole-file read of the manual truncates before the phone page', async () => {
    await seedEvalSource();
    const manual = await Asset.findOne({ userId, filename: 'long-manual.md' });
    const text = manual?.textExtracted ?? '';
    expect(text.length).toBeGreaterThan(MAX_PROMPT_TEXT_CHARS);
    expect(truncateForPrompt(text).includes(SUPPORT_PHONE)).toBe(false);
  });

  it('seeds the #159 handbook with one unit per heading-2 section', async () => {
    await seedEvalSource();
    const handbook = await Asset.findOne({ userId, filename: 'project-handbook.md' }).select(
      '+units',
    );
    const units = handbook?.get('units') ?? [];
    expect(units).toHaveLength(6);
    expect(units.map((u: { label: string }) => u.label)).toEqual([
      'Overview',
      'Onboarding',
      'Expense policy',
      'Remote work',
      'Escalation',
      'Glossary',
    ]);
    expect((handbook?.textExtracted ?? '').includes('## Overview')).toBe(true);
  });

  it('clearEvalSource removes the eval user and every seeded asset', async () => {
    await seedEvalSource();
    await clearEvalSource();
    expect(await Asset.countDocuments({ userId })).toBe(0);
  });
});
