// Incident-context re-roll for #420: re-sample the exact persisted context of each Oct 19
// stray-token incident on both hosts. Elevated flip rate here (vs 256 clean battery
// generations) means the trigger is in the session content; clean means the un-persisted
// production assembly (instructions/tools/chips) or the streaming path carries it.
// Usage: npx tsx scripts/stray-reroll.ts [--pilot] [--concurrency 6]
import 'dotenv/config';
import './batteryEnvClear';
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { buildMongoUri } from '../apps/shared/src/main/mongoUri';
import type { LlmProvider, LlmConnector } from '../apps/server/src/main/services/llm/llmTypes';
import {
  deepinfraConnector,
  fireworksConnector,
} from '../apps/server/src/main/services/llm/mastraService';
import { windowedHistory } from '../apps/server/src/main/routes/chat';
import { CHAT_MODEL } from '../apps/server/src/main/services/model/modelDefaults';

const OUT_DIR = 'data/stray-battery';
const EMAIL = 'formsatz@gmail.com';
const CJK_G =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF66-\uFF9D\u3000-\u303F]/g;
const ROLLS = 6;

// The five verified incidents: session ObjectId suffix, incident timestamp, the stray.
const INCIDENTS: { sessionSuffix: string; at: string; stray: string }[] = [
  { sessionSuffix: '00ae5e', at: '2026-10-19T09:02:15.085Z', stray: '一度有一点' },
  { sessionSuffix: '00ae5e', at: '2026-10-19T09:07:17.034Z', stray: '军舰' },
  { sessionSuffix: '4f386b', at: '2026-10-19T08:36:37.096Z', stray: '的诊断' },
  { sessionSuffix: 'a90392', at: '2026-10-19T09:38:54.933Z', stray: '过程中' },
  { sessionSuffix: '029841', at: '2026-10-19T11:27:31.760Z', stray: '死神' },
];

const argv = process.argv.slice(2);
const argOf = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const pilot = argv.includes('--pilot');
const only = argOf('--only');
const rollsArg = Number(argOf('--rolls') ?? '') || ROLLS;
const tempsArg = argOf('--temps');
const temps = tempsArg ? tempsArg.split(',').map(Number) : [0, 0.2];
const concurrency = Number(argOf('--concurrency') ?? '') || 6;

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

type Row = {
  incident: string;
  provider: LlmProvider;
  temperature: number;
  roll: number;
  context_chars: number;
  output_chars: number;
  strays: { char: string; pos_pct: number; before: string; after: string }[];
};

const histogram = (pcts: number[]) => {
  const h: Record<string, number> = {};
  for (const p of pcts) {
    const b =
      p === 0 ? '0' : `${Math.floor((p - 1) / 10) * 10 + 1}-${Math.floor((p - 1) / 10) * 10 + 10}`;
    h[b] = (h[b] ?? 0) + 1;
  }
  return h;
};

async function main() {
  const client = new MongoClient(buildMongoUri());
  await client.connect();
  const arms: {
    incident: string;
    provider: LlmProvider;
    temperature: number;
    messages: Msg[];
    contextChars: number;
  }[] = [];
  try {
    const db = client.db('tova');
    const user = await db.collection('users').findOne({ email: EMAIL });
    if (!user) throw new Error('user not found');
    const sessions = await db
      .collection('sessions')
      .find({ userId: user._id })
      .project({ _id: 1 })
      .toArray();

    for (const inc of INCIDENTS) {
      if (only && !inc.at.startsWith(`2026-10-19T${only}`)) continue;
      const session = sessions.find((s) => s._id.toString().endsWith(inc.sessionSuffix));
      if (!session) throw new Error(`session ${inc.sessionSuffix} not found`);
      const docs = await db
        .collection('messages')
        .find({ sessionId: session._id, timestamp: { $lte: new Date(inc.at) } })
        .sort({ timestamp: 1 })
        .project({ role: 1, content: 1, _id: 0 })
        .toArray();
      // Drop the trailing incident response itself: re-roll from the user turn that prompted it.
      while (docs.length && (docs.at(-1) as { role?: string } | undefined)?.role !== 'user')
        docs.pop();
      docs.pop(); // and the prompting user turn becomes the final message, not history
      if (docs.length < 2) throw new Error(`${inc.sessionSuffix}: too short to reconstruct`);
      const promptTurn = docs.pop()!;
      const windowed = windowedHistory(docs as { role?: string; content?: string | null }[]);
      // Oldest-first replay of the exact pre-incident history, prompting user turn last.
      const ordered: Msg[] = [
        ...windowed.map((d) => ({
          role: (d.role ?? 'user') as Msg['role'],
          content: d.content ?? '',
        })),
        { role: 'user', content: promptTurn.content ?? '' },
      ];
      const contextChars = ordered.reduce((a, m) => a + m.content.length, 0);
      const halfCut = Math.max(1, Math.floor(ordered.length / 2));
      const half = ordered.slice(0, halfCut);

      for (const provider of ['deepinfra', 'fireworks'] as LlmProvider[])
        for (const temperature of temps) {
          arms.push({
            incident: `${inc.sessionSuffix}@${inc.at.slice(11, 16)}(${inc.stray})`,
            provider,
            temperature,
            messages: ordered,
            contextChars,
          });
        }
      // Dose arm: half-depth replay, deepinfra, task temp.
      arms.push({
        incident: `${inc.sessionSuffix}@${inc.at.slice(11, 16)}(half)`,
        provider: 'deepinfra',
        temperature: 0.2,
        messages: half,
        contextChars: half.reduce((a, m) => a + m.content.length, 0),
      });
    }
  } finally {
    await client.close();
  }

  const connectors: Record<string, LlmConnector> = {
    deepinfra: deepinfraConnector,
    fireworks: fireworksConnector,
  };
  const runOne = async (arm: (typeof arms)[number], roll: number): Promise<Row> => {
    const completion = await connectors[arm.provider].createCompletion({
      model: arm.provider === 'fireworks' ? 'accounts/fireworks/models/glm-5p3-flash' : CHAT_MODEL,
      messages: arm.messages,
      temperature: arm.temperature,
      max_tokens: 8192,
    });
    const text = completion.choices[0]?.message?.content ?? '';
    const contextText = arm.messages.map((m) => m.content).join('\n');
    const strays: Row['strays'] = [];
    for (const m of text.matchAll(CJK_G)) {
      if (contextText.includes(m[0])) continue; // echoed from context: legitimate
      const at = m.index ?? 0;
      strays.push({
        char: m[0],
        pos_pct: Math.round((at / Math.max(1, text.length)) * 100),
        before: text.slice(Math.max(0, at - 60), at),
        after: text.slice(at + 1, at + 60),
      });
    }
    return {
      incident: arm.incident,
      provider: arm.provider,
      temperature: arm.temperature,
      roll,
      context_chars: arm.contextChars,
      output_chars: text.length,
      strays,
    };
  };

  const jobs = arms.flatMap((arm, i) =>
    Array.from({ length: pilot ? 1 : rollsArg }, (_, r) => ({ arm, i, r })),
  );
  const results: Row[] = [];
  const total = jobs.length;
  let done = 0;
  const pool = Array.from({ length: concurrency }, async () => {
    while (jobs.length) {
      const job = jobs.shift();
      if (!job) break;
      try {
        results.push(await runOne(job.arm, job.r));
      } catch (err) {
        console.error(
          `[${job.arm.incident}#${job.r}] failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      done++;
      if (done % 10 === 0 || done === total) console.log(`${done}/${total}`);
    }
  });
  await Promise.all(pool);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `reroll-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  fs.writeFileSync(out, results.map((r) => JSON.stringify(r)).join('\n'));
  console.log(`\nwrote ${results.length} rows to ${out}\n`);

  const byArm = new Map<string, Row[]>();
  for (const r of results) {
    const k = `${r.incident} ${r.provider} t=${r.temperature}`;
    const list = byArm.get(k) ?? [];
    list.push(r);
    byArm.set(k, list);
  }
  for (const [k, rows] of [...byArm].sort()) {
    const withStrays = rows.filter((r) => r.strays.length > 0).length;
    console.log(
      `${k}: n=${rows.length} strays=${rows.reduce((a, r) => a + r.strays.length, 0)} armsWithStrays=${withStrays}`,
    );
    for (const r of rows.filter((r) => r.strays.length).slice(0, 2))
      for (const s of r.strays.slice(0, 2)) console.log(`   …${s.before}[${s.char}]${s.after}…`);
  }
}

export {};

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1])))
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
