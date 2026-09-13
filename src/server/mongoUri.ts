export const buildMongoUri = (
  host = process.env.MONGODB_HOST ?? 'localhost',
  password = process.env.MONGODB_PASSWORD,
): string => `mongodb://tova:${password}@${host}/tova?authSource=admin`;
