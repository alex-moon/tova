import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { buildMongoUri } from '../../../shared/src/main/mongoUri';

// Django-style management commands: flat registry + argv router.
// @see #322

export interface ManageCommand {
  description: string;
  run: (args: string[]) => Promise<void> | void;
}

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

// Probe fixtures: PNGs assert color, kitten.jpg asserts real photo OCR.
// @see #318
const fixtureDataUrl = async (file: string, mediaType: string): Promise<string> => {
  const b64 = await readFile(path.join(__dirname, 'services', 'fixtures', file), 'base64');
  return `data:${mediaType};base64,${b64}`;
};

interface ProbeTarget {
  name: string;
  url: string;
  model: string;
  keyEnvVar: string;
  /** DeepInfra rejects images in tool messages at the schema level. */
  // @see #318
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
  seesImage: boolean;
  /** What a model that truly saw the image answers. */
  expect: RegExp;
  prompt: string;
  /** Tool-message variant: the image rides the tool result. */
  viaTool?: boolean;
  /** Attempt allowance — hard perception cases flake more (default 2). */
  attempts?: number;
};

const PROBE_CASES: ProbeCase[] = [
  {
    name: 'user message, red.png',
    fixture: ['red.png', 'image/png'],
    seesImage: true,
    expect: /\bred\b/i,
    prompt: 'What color is this image? Answer with one word.',
  },
  {
    name: 'user message, blue.png',
    fixture: ['blue.png', 'image/png'],
    seesImage: true,
    expect: /\bblue\b/i,
    prompt: 'What color is this image? Answer with one word.',
  },
  {
    name: 'user message, kitten.jpg',
    fixture: ['kitten.jpg', 'image/jpeg'],
    seesImage: true,
    expect: /\bcat|kitten\b/i,
    prompt: 'What is in this image? Answer briefly.',
  },
  {
    name: 'user message, whiteboard.jpg (handwriting)',
    fixture: ['whiteboard.jpg', 'image/jpeg'],
    seesImage: true,
    // Distinctive menu items — unreadable without parsing handwriting.
    expect: /\bcroissant|lemonade|barbeque|barbecue\b/i,
    prompt: 'Read the whiteboard. Name one food or drink item written on it.',
    attempts: 3,
  },
  {
    name: 'user message, street.jpg (busy scene)',
    fixture: ['street.jpg', 'image/jpeg'],
    seesImage: true,
    // Small sign text / vehicle — needs more than a vague scene guess.
    expect: /\bone way\b|\bbus\b/i,
    prompt: 'Look at the street scene. What text is visible on a sign, and is there a bus?',
    attempts: 3,
  },
  {
    name: 'tool message, red.png',
    fixture: ['red.png', 'image/png'],
    seesImage: true,
    expect: /\bred\b/i,
    viaTool: true,
    prompt: 'view_image was already called. What color is the image? One word.',
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
                content: probeCase.prompt,
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
                content: [{ type: 'text', text: probeCase.prompt }, imagePart],
              },
            ];
        // Live perception is noisy; each case gets one retry on failure.
        const attemptsAllowed = probeCase.attempts ?? 2;
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
                // Reasoning models emit long reasoning_content; cap it hard.
                max_tokens: 400,
              }),
            });
            status = res.status;
            answer = res.ok ? answerText(await res.json()) : await res.text();
          } catch (err) {
            answer = String(err);
          }
          // Pass = HTTP accepted; image cases must also perceive.
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
        // Documented DeepInfra limit: tool-message images rejected; not a bug.
        // @see #318
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

export const commands: Record<string, ManageCommand> = {
  roster: rosterCommand,
  'probe:image-tools': probeImageToolsCommand,
};
