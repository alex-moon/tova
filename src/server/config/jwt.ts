let warned = false;

export const JWT_SECRET_ENV_VAR = 'JWT_SECRET';

export const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (secret) {
    return secret;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${JWT_SECRET_ENV_VAR} must be set when NODE_ENV is 'production'`);
  }

  if (!warned) {
    warned = true;
    console.warn(
      '%s is not set; using an insecure fallback secret (development only)',
      JWT_SECRET_ENV_VAR,
    );
  }
  return 'fallback_secret';
};
