import {
  AllModelsDisabledError,
  ALL_MODELS_DISABLED_MESSAGE,
  overloadCoolOffMinutes,
  sweepModels,
} from '../../main/services/modelConfigService';

/* Tier-free provider plumbing plus the roster-backed eval sweep bridge. */
// @see #233
describe('modelConfigService survivors (#233)', () => {
  it('exposes the end-user all-disabled message through the error', () => {
    const err = new AllModelsDisabledError();
    expect(err.message).toBe(ALL_MODELS_DISABLED_MESSAGE);
    expect(err.name).toBe('AllModelsDisabledError');
    expect(err).toBeInstanceOf(Error);
  });

  describe('overloadCoolOffMinutes (#213)', () => {
    afterEach(() => {
      delete process.env.MODEL_OVERLOAD_COOL_OFF_MINUTES;
    });

    it('defaults to 5 minutes', () => {
      expect(overloadCoolOffMinutes()).toBe(5);
    });

    it('honours a valid env override and rejects garbage', () => {
      process.env.MODEL_OVERLOAD_COOL_OFF_MINUTES = '12';
      expect(overloadCoolOffMinutes()).toBe(12);
      process.env.MODEL_OVERLOAD_COOL_OFF_MINUTES = '0';
      expect(overloadCoolOffMinutes()).toBe(5);
      process.env.MODEL_OVERLOAD_COOL_OFF_MINUTES = 'nope';
      expect(overloadCoolOffMinutes()).toBe(5);
      process.env.MODEL_OVERLOAD_COOL_OFF_MINUTES = '';
      expect(overloadCoolOffMinutes()).toBe(5);
    });
  });

  describe('sweepModels (#233 roster bridge)', () => {
    it('enumerates the roster as provider:model rows (#316: two models, four rows)', () => {
      const models = sweepModels();
      expect(models).toHaveLength(4);
      expect(models).toContainEqual({
        provider: 'deepinfra',
        model: 'deepseek-ai/DeepSeek-V4.1-Flash',
      });
      expect(models).toContainEqual({
        provider: 'fireworks',
        model: 'accounts/fireworks/models/deepseek-v4p1-flash',
      });
    });

    it('narrows to the requested providers', () => {
      const onlyFireworks = sweepModels(['fireworks']);
      expect(onlyFireworks.length).toBeGreaterThan(0);
      expect(onlyFireworks.every((m) => m.provider === 'fireworks')).toBe(true);
    });

    it('returns no duplicates', () => {
      const keys = sweepModels().map((m) => `${m.provider}:${m.model}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});
