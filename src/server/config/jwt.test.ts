import { getJwtSecret, JWT_SECRET_ENV_VAR } from './jwt';

describe('getJwtSecret', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.JWT_SECRET;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.spyOn(console, 'warn').mockRestore();
  });

  it.each<string>(['production'])('throws when env is %s and JWT_SECRET is missing', (env) => {
    process.env.NODE_ENV = env;
    expect(() => getJwtSecret()).toThrow(
      new RegExp(`^${JWT_SECRET_ENV_VAR} must be set when NODE_ENV is 'production'$`),
    );
  });

  it('returns the configured secret in production when JWT_SECRET is set', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a-real-secret';
    expect(getJwtSecret()).toBe('a-real-secret');
  });

  it('warns once and falls back when not production and JWT_SECRET is missing', () => {
    process.env.NODE_ENV = 'test';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    expect(getJwtSecret()).toBe('fallback_secret');
    expect(getJwtSecret()).toBe('fallback_secret');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(JWT_SECRET_ENV_VAR));
  });
});
