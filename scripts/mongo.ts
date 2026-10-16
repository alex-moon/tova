import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { buildMongoUri } from '../apps/shared/src/main/mongoUri';

const uri = buildMongoUri();

const snippet = process.argv[2];
if (!snippet) {
  console.error('Usage: npx tsx scripts/mongo.ts <js-expression>');
  process.exit(1);
}

async function main() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('tova');
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const result = await new AsyncFunction('db', `return (${snippet})`)(db);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
