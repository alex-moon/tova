import { commands, formatSeconds } from '../main/manageCommands';

/* Registry shape and the pure formatting helper behind the probe output. */
// @see #322 #387

describe('manage command registry (#322/#387)', () => {
  it('exposes the image-tool probe command with a description', () => {
    expect(Object.keys(commands).sort()).toEqual(['probe:image-tools']);
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
