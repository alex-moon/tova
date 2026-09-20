export const buildMongoUri = (
  dbName?: string,
  host = process.env.MONGODB_HOST ?? 'localhost',
  password = process.env.MONGODB_PASSWORD,
): string =>
  `mongodb://tova:${password}@${host}/${encodeURIComponent(dbName ?? 'tova')}?authSource=admin`;
