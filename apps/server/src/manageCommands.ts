import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { buildMongoUri } from '../../shared/src/mongoUri';

/*
 * #322: Django-style management commands for the server app — a flat registry
 * and an argv router (`manage.ts` is the thin entry). Commands use the raw
 * `mongodb` driver + shared `buildMongoUri` (the `scripts/mongo.ts` pattern),
 * not the server's mongoose/config stack, so the CLI stays light and
 * side-effect-free. Run via `npm run manage -- <command> [args]`.
 */

export interface ManageCommand {
  description: string;
  run: (args: string[]) => Promise<void> | void;
}

/* ----------------------------------------------------------------------------
 * Formatting helpers (pure, unit-tested)
 * ------------------------------------------------------------------------- */

export const formatSeconds = (ms: number | undefined | null): string => {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '-';
  return `${(ms / 1000).toFixed(1)}s`;
};

interface RosterProviderRow {
  provider: string;
  modelId?: string;
  enabled?: boolean;
  ttftMs?: number;
  ttftSamples?: number;
  disabledUntil?: Date | string | null;
}

interface RosterRow {
  modelId: string;
  label?: string;
  eligible?: boolean;
  providers?: RosterProviderRow[];
}

const pad = (value: string, width: number): string => value.padEnd(width, ' ');

export const formatRosterRow = (row: RosterRow): string[] =>
  (row.providers ?? []).map((p) =>
    [
      pad(row.modelId, 34),
      pad(row.eligible === false ? 'no' : 'yes', 9),
      pad(p.provider, 11),
      pad(p.enabled === false ? 'no' : 'yes', 8),
      pad(formatSeconds(p.ttftMs), 10),
      pad(String(p.ttftSamples ?? 0), 8),
      pad(
        p.disabledUntil && new Date(p.disabledUntil).getTime() > Date.now()
          ? `until ${new Date(p.disabledUntil).toISOString().slice(0, 16).replace('T', ' ')}`
          : '-',
        24,
      ),
    ].join(''),
  );

export const ROSTER_HEADER = `${pad('MODEL', 34)}${pad('ELIGIBLE', 9)}${pad('PROVIDER', 11)}${pad('ENABLED', 8)}${pad('TTFT', 10)}${pad('SAMPLES', 8)}${pad('COOLOFF', 24)}`;

/* ----------------------------------------------------------------------------
 * roster — live roster + windowed TTFT readout (#320)
 * ------------------------------------------------------------------------- */

export const rosterCommand: ManageCommand = {
  description: 'Print the live model roster: eligibility, per-provider windowed TTFT, cool-offs',
  run: async () => {
    const client = new MongoClient(buildMongoUri());
    try {
      await client.connect();
      const rows = await client.db('tova').collection<RosterRow>('modelrosters').find({}).toArray();
      console.log(ROSTER_HEADER);
      for (const row of rows) for (const line of formatRosterRow(row)) console.log(line);
      console.log(
        `\n${rows.length} model(s), ${rows.reduce((n, r) => n + (r.providers?.length ?? 0), 0)} provider entr(ies)`,
      );
    } finally {
      await client.close();
    }
  },
};

/* ----------------------------------------------------------------------------
 * probe:image-tools — #318 verification probe
 * ------------------------------------------------------------------------- */

/*
 * #318 probe fixtures (owner-provided): red/blue 8×8 PNGs assert actual color
 * perception (two colors guard against lucky pattern matching), kitten.jpg a
 * real photo asserts content recognition. bike-snow.jpg stays in fixtures for
 * the #318 golden-path tests.
 */
const fixtureDataUrl = async (file: string, mediaType: string): Promise<string> => {
  const b64 = await readFile(path.join(__dirname, 'services', 'fixtures', file), 'base64');
  return `data:${mediaType};base64,${b64}`;
};

interface ProbeTarget {
  name: string;
  url: string;
  model: string;
  keyEnvVar: string;
  /** DeepInfra rejects images in tool messages at the schema level (#318). */
  toolImageExpected: boolean;
}

const PROBE_TARGETS: ProbeTarget[] = [
  {
    name: 'deepinfra',
    url: 'https://api.deepinfra.com/v1/openai/chat/completions',
    model: 'zai-org/GLM-5.3-Flash',
    keyEnvVar: 'DEEPINFRA_API_KEY',
    toolImageExpected: false,
  },
  {
    name: 'fireworks',
    url: 'https://api.fireworks.ai/inference/v1/chat/completions',
    model: 'accounts/fireworks/models/glm-5p3-flash',
    keyEnvVar: 'FIREWORKS_API_KEY',
    toolImageExpected: true,
  },
];

const toolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'view_image', arguments: '{"id":"probe"}' },
};

type ProbeCase = {
  name: string;
  fixture: [file: string, mediaType: string];
  /** Whether the model is expected to actually SEE the image. */
  seesImage: boolean;
  /** What a model that truly saw the image answers. */
  expect: RegExp;
  /** Tool-message variant: the image rides the tool result instead of the user turn. */
  viaTool?: boolean;
};

const PROBE_CASES: ProbeCase[] = [
  {
    name: 'user message, red.png',
    fixture: ['red.png', 'image/png'],
    seesImage: true,
    expect: /\bred\b/i,
  },
  {
    name: 'user message, blue.png',
    fixture: ['blue.png', 'image/png'],
    seesImage: true,
    expect: /\bblue\b/i,
  },
  {
    name: 'user message, kitten.jpg',
    fixture: ['kitten.jpg', 'image/jpeg'],
    seesImage: true,
    expect: /\bcat|kitten\b/i,
  },
  {
    name: 'tool message, red.png',
    fixture: ['red.png', 'image/png'],
    seesImage: true,
    expect: /\bred\b/i,
    viaTool: true,
  },
];

const answerText = (body: {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
}): string =>
  [body.choices?.[0]?.message?.content, body.choices?.[0]?.message?.reasoning_content]
    .filter(Boolean)
    .join(' ');

export const probeImageToolsCommand: ManageCommand = {
  description:
    '#318 probe: image-in-tool-message vs image-in-user-message wire matrix (both roster providers)',
  run: async () => {
    const uniqueFiles = [
      ...new Map(PROBE_CASES.map((c): [string, string] => [c.fixture[0], c.fixture[1]])).entries(),
    ];
    const fixtures = new Map(
      await Promise.all(
        uniqueFiles.map(async ([file, mediaType]): Promise<[string, string]> => [
          file,
          await fixtureDataUrl(file, mediaType),
        ]),
      ),
    );
    let failures = 0;
    for (const target of PROBE_TARGETS) {
      const key = process.env[target.keyEnvVar];
      if (!key) {
        console.error(`${target.name}: ${target.keyEnvVar} missing — skipping`);
        failures += 1;
        continue;
      }
      for (const probeCase of PROBE_CASES) {
        const dataUrl = fixtures.get(probeCase.fixture[0]) as string;
        const imagePart = { type: 'image_url', image_url: { url: dataUrl } };
        const messages = probeCase.viaTool
          ? [
              {
                role: 'user',
                content: 'view_image was already called. What color is the image? One word.',
              },
              { role: 'assistant', content: null, tool_calls: [toolCall] },
              {
                role: 'tool',
                tool_call_id: 'call_1',
                content: [{ type: 'text', text: 'view_image result:' }, imagePart],
              },
            ]
          : [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'What is in this image? Answer briefly.' },
                  imagePart,
                ],
              },
            ];
        /*
         * Live-model perception is noisy (one run described the blue square as
         * "solid dark red"; the next named it correctly), so each case gets a
         * retry before it counts as a failure.
         */
        const attemptsAllowed = 2;
        let status = 0;
        let answer = '';
        let ok = false;
        let saw = false;
        for (let attempt = 1; attempt <= attemptsAllowed && !ok; attempt += 1) {
          try {
            const res = await fetch(target.url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
              body: JSON.stringify({
                model: target.model,
                messages,
                max_tokens: 60,
              }),
            });
            status = res.status;
            answer = res.ok ? answerText(await res.json()) : await res.text();
          } catch (err) {
            answer = String(err);
          }
          // A case "passes" when the HTTP shape is accepted; when the case is
          // expected to deliver the image, the model must also answer with the
          // expected perception.
          const accepted = status === 200;
          saw = accepted && probeCase.seesImage && probeCase.expect.test(answer);
          ok = accepted && (!probeCase.seesImage || saw);
          const expectedRejection = Boolean(probeCase.viaTool) && !target.toolImageExpected;
          if (!ok && !expectedRejection && attempt < attemptsAllowed) {
            console.log(`${target.name} | ${probeCase.name}: attempt ${attempt} not ok — retrying`);
          }
        }
        const accepted = status === 200;
        const expectedRejection = Boolean(probeCase.viaTool) && !target.toolImageExpected;
        if (!ok && !expectedRejection) failures += 1;
        const why = !accepted
          ? `rejected (HTTP ${status})`
          : probeCase.seesImage && !saw
            ? 'image NOT seen (wrong/hallucinated answer)'
            : 'ok';
        console.log(
          `${target.name} | ${probeCase.name}: HTTP ${status} ${answer ? JSON.stringify(answer.slice(0, 80)) : ''} — ${why}`,
        );
        // Documented provider limitation (#318): DeepInfra rejects tool-message
        // images at the schema level. Expected, not a regression.
        if (!accepted && probeCase.viaTool) {
          console.log(
            `  (expected: ${target.name} ${target.toolImageExpected ? 'accepts' : 'rejects'} images in tool messages — #318)`,
          );
        }
      }
    }
    if (failures > 0) {
      console.error(`\n${failures} probe failure(s)`);
      process.exitCode = 1;
    } else {
      console.log('\nprobe: all expected behaviors confirmed');
    }
  },
};

/* ----------------------------------------------------------------------------
 * Registry
 * ------------------------------------------------------------------------- */

export const commands: Record<string, ManageCommand> = {
  roster: rosterCommand,
  'probe:image-tools': probeImageToolsCommand,
};
