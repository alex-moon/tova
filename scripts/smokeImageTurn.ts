import 'dotenv/config';
import zlib from 'node:zlib';
import { deepinfraConnector, groqConnector } from '../apps/server/src/services/mastraService';

/*
 * Manual smoke for #115: drives the real in-process DeepInfra connector
 * (`deepinfraConnector` -> `mastraMessagesFor` -> Mastra agent) with a
 * multimodal turn (text + `image_url` data URI part) against whatever model
 * the caller names. Requires DEEPINFRA_API_KEY in .env. No Mongo, no
 * storage: the image part is a data URI of an in-memory generated PNG, so
 * this exercises the full #115 mapping path minus presigned Spaces URLs
 * (those need DO_SPACES_* credentials; the URL variant is probed live in
 * the plan doc).
 *
 * Usage: npx tsx scripts/smokeImageTurn.ts [model]
 *   model defaults to Qwen/Qwen3-VL-30B-A3B-Instruct (seeded large-tier
 *   vision; all image turns route large-only per the #115 user decision).
 */

const MODEL = process.argv[2] ?? 'Qwen/Qwen3-VL-30B-A3B-Instruct';

const crc32 = (buf: Buffer): number => zlib.crc32(buf) >>> 0;

const pngChunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/* Solid single-colour RGB PNG (the whole point: the answer must name it). */
const solidPng = (r: number, g: number, b: number, size = 32): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.from([0, ...Array.from({ length: size * 3 }, () => 0)]);
  for (let i = 0; i < size * 3; i += 3) {
    row[1 + i] = r;
    row[2 + i] = g;
    row[3 + i] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

async function main() {
  if (!process.env.DEEPINFRA_API_KEY) {
    console.error('DEEPINFRA_API_KEY missing — set it in .env');
    process.exit(1);
  }
  const png = solidPng(255, 0, 0);
  const dataUri = `data:image/png;base64,${png.toString('base64')}`;
  console.log(`model: ${MODEL}, image: ${png.length} bytes (solid red PNG, data URI)`);

  const result = await deepinfraConnector.createToolFreeCompletion({
    provider: 'deepinfra',
    model: MODEL,
    // Same part shape the chat route assembles (#115): text turn text plus
    // the image under `image_url.url`.
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is the dominant colour of this image? One word.' },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
    max_tokens: 32,
  });
  const text = result.choices[0]?.message?.content;
  console.log(`answer: ${text}`);
  if (!text || !/red/i.test(text)) {
    console.error('FAIL: answer does not name the colour "red"');
    process.exit(1);
  }
  console.log('PASS');

  // Negative control: the Groq connector must refuse multimodal content.
  try {
    await groqConnector.createToolFreeCompletion({
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'x' },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
    });
    console.error('FAIL: Groq connector accepted multimodal content');
    process.exit(1);
  } catch (error) {
    console.log(`groq rejected multimodal as designed: ${(error as Error).message}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
