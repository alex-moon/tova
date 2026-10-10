// Two connection paths (issue #138): MONGODB_URL takes precedence when set and
// is returned verbatim — never re-parsed or reassembled — so a spec-accurate
// Atlas `mongodb+srv://...` URL (or any full URL, credential and options
// included) passes through untouched; the dbName argument does not apply to
// it, since the URL carries its own database. When MONGODB_URL is unset,
// the dev fallback assembles a URI from MONGODB_HOST/MONGODB_PASSWORD for the
// plain-Mongo docker compose stack (authSource=admin against the local image).
export const buildMongoUri = (
  dbName?: string,
  host = process.env.MONGODB_HOST ?? 'localhost',
  password = process.env.MONGODB_PASSWORD,
): string => {
  const url = process.env.MONGODB_URL?.trim();
  if (url) return url;
  return `mongodb://tova:${password}@${host}/${encodeURIComponent(dbName ?? 'tova')}?authSource=admin`;
};
