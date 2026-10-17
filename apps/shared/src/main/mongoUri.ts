// Mongo connection string assembly shared by server, migrations, and scripts: MONGODB_URL passes through verbatim; the dev fallback assembles from host/password.
// @see #257 #138
export const buildMongoUri = (
  dbName?: string,
  host = process.env.MONGODB_HOST ?? 'localhost',
  password = process.env.MONGODB_PASSWORD,
): string => {
  const url = process.env.MONGODB_URL?.trim();
  if (url) return url;
  return `mongodb://tova:${password}@${host}/${encodeURIComponent(dbName ?? 'tova')}?authSource=admin`;
};
