import { commands, formatSeconds, formatRosterRow, ROSTER_HEADER } from '../main/manageCommands';

/*
 * #322: registry shape and the pure formatting helpers behind the `roster`
 * readout. The commands themselves are thin live-infra wrappers (driver reads
 * and wire probes) and are exercised by running them, not by unit tests.
 */

describe('manage command registry (#322)', () => {
  it('exposes the roster and image-tool probe commands with descriptions', () => {
    expect(Object.keys(commands).sort()).toEqual(['probe:image-tools', 'roster']);
    for (const entry of Object.values(commands)) {
      expect(entry.description).toBeTruthy();
      expect(typeof entry.run).toBe('function');
    }
  });
});

describe('formatSeconds', () => {
  it('renders milliseconds as seconds with one decimal', () => {
    expect(formatSeconds(6949)).toBe('6.9s');
    expect(formatSeconds(18450.5)).toBe('18.5s');
  });

  it('renders missing/non-finite values as a dash', () => {
    expect(formatSeconds(undefined)).toBe('-');
    expect(formatSeconds(null)).toBe('-');
    expect(formatSeconds(NaN)).toBe('-');
  });
});

describe('formatRosterRow', () => {
  it('renders one line per provider entry with eligibility, TTFT and cool-off', () => {
    // Relative to now: the fixture once hardcoded a date that aged into the
    // past, and the formatter (correctly) drops expired cool-offs.
    const coolOff = new Date(Date.now() + 60 * 60 * 1000);
    const lines = formatRosterRow({
      modelId: 'zai-org/GLM-5.3-Flash',
      eligible: true,
      providers: [
        { provider: 'deepinfra', enabled: true, ttftMs: 5668.12, ttftSamples: 33 },
        {
          provider: 'fireworks',
          enabled: true,
          ttftMs: 18500,
          ttftSamples: 31,
          disabledUntil: coolOff,
        },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('zai-org/GLM-5.3-Flash');
    expect(lines[0]).toContain('deepinfra');
    expect(lines[0]).toContain('5.7s');
    expect(lines[0]).toContain('33');
    expect(lines[1]).toContain('fireworks');
    expect(lines[1]).toContain('18.5s');
    expect(lines[1]).toContain(`until ${coolOff.toISOString().slice(0, 16).replace('T', ' ')}`);
  });

  it('renders an expired cool-off as uncooled', () => {
    const lines = formatRosterRow({
      modelId: 'm',
      providers: [{ provider: 'deepinfra', disabledUntil: new Date(Date.now() - 1000) }],
    });
    expect(lines[0].trimEnd().endsWith('-')).toBe(true);
  });

  it('renders a fresh (uncooled) provider without a cool-off date', () => {
    const lines = formatRosterRow({
      modelId: 'm',
      providers: [{ provider: 'deepinfra', disabledUntil: null }],
    });
    expect(lines[0].trimEnd().endsWith('-')).toBe(true);
  });

  it('aligns columns with the header', () => {
    const lines = formatRosterRow({
      modelId: 'm',
      providers: [{ provider: 'deepinfra' }],
    });
    // The provider column starts where the header says it does.
    expect(lines[0].indexOf('deepinfra')).toBe(ROSTER_HEADER.indexOf('PROVIDER'));
  });
});
