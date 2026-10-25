// Stray-token battery v2 for #420 — escalation per the pre-registered observation trap:
// v1 (recite, 139k-char max depth) ran 128 generations clean, so the regime moves to the
// full windowedHistory ceiling (400k chars) and long-form generation. Decision rule:
// docs/plan-420-stray-glyph-battery.md.
// Usage: npx tsx scripts/stray-glyph-battery.ts [--pilot] [--cells A1,C1] [--concurrency 6]
import 'dotenv/config';
import './batteryEnvClear';
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { buildMongoUri } from '../apps/shared/src/main/mongoUri';
import type { LlmProvider, LlmConnector } from '../apps/server/src/main/services/llm/llmTypes';
import {
  BACKEND_IDS,
  CHAT_MODEL,
  TASK_MODEL,
  contextLengthFor,
} from '../apps/server/src/main/services/model/modelDefaults';
import { windowedHistory } from '../apps/server/src/main/routes/chat';
import {
  deepinfraConnector,
  fireworksConnector,
} from '../apps/server/src/main/services/llm/mastraService';
const connectors: Record<'deepinfra' | 'fireworks', LlmConnector> = {
  deepinfra: deepinfraConnector,
  fireworks: fireworksConnector,
};

const OUT_DIR = 'data/stray-battery';
const EMAIL = 'formsatz@gmail.com';
const CJK_G =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF66-\uFF9D\u3000-\u303F]/g;

// Flip-prone vocabulary: words with common CJK glosses (model, party, almost, process, …).
const CANARY = [
  'The harbour board met on a Tuesday to argue about the lighthouse.',
  'Arguably the keeper had a point: the lamp was brighter than the model predicted, and the',
  'diagnosis of the fault changed almost overnight once the new lens arrived in the process',
  'crate. Many parties wanted the minutes; none of them read the appendix. The party that',
  'did was the one that had not changed its mind since the war, when festival dates took on',
  'death-honouring overtones and the board still wrote its letters by hand. If you ask',
  'whether the numbers moved, the honest answer is that the rate is high but the sample is',
  'small, and the model disagreement between the two auditors was never really resolved.',
].join(' ');

const system = 'You are a precise assistant. Follow the user instruction exactly. No commentary.';
const reciteInline = `Recite the following passage back exactly, verbatim, with no commentary:\n\n${CANARY}`;
const reciteFromHistory =
  'Recite the passage I saved earlier in this conversation back to me exactly, verbatim, with no commentary.';
const longformFromHistory =
  'Draft a detailed technical document of roughly 1500 words summarising the work and the discussion in this conversation so far. Cover the main threads in depth, one section per thread, with concrete detail from the conversation.';

const argv = process.argv.slice(2);
const argOf = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const pilot = argv.includes('--pilot');
const cellFilter = argOf('--cells');
const concurrency = Number(argOf('--concurrency') ?? '') || 6;

type Row = {
  cell: string;
  context_variant: 'short' | 'deepmax' | 'dirty';
  task: 'recite' | 'longform';
  temperature: number;
  provider: LlmProvider;
  model: string;
  output_chars: number;
  finish_reason: string | undefined;
  stray_chars: number;
  cjk_substitutions: number;
  nearmiss_substitutions: number;
  paraphrase_words: number;
  position_histogram: Record<string, number>;
  examples: { expected: string; actual: string; kind: string; pos_pct: number }[];
};

const stripFences = (text: string) => text.replace(/```[\s\S]*?```/g, '');

// CJK runs count as "words" so a gloss flip pairs against the expected English word in the diff.
const words = (text: string) => text.toLowerCase().match(/[a-z0-9']+|[^\sa-z0-9']+/gi) ?? [];

const lev = (a: string, b: string) => {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length][b.length];
};

type Sub = {
  expected: string;
  actual: string;
  kind: 'cjk' | 'nearmiss' | 'paraphrase';
  pos_pct: number;
};

const diffWords = (expected: string, actual: string): Sub[] => {
  const ew = words(expected);
  const aw = words(actual);
  const dp: number[][] = Array.from({ length: ew.length + 1 }, () => Array(aw.length + 1).fill(0));
  for (let i = ew.length - 1; i >= 0; i--)
    for (let j = aw.length - 1; j >= 0; j--)
      dp[i][j] = ew[i] === aw[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  type Op = { d?: string; a?: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < ew.length && j < aw.length) {
    if (ew[i] === aw[j]) {
      ops.push({});
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ d: ew[i] });
      i++;
    } else {
      ops.push({ a: aw[j] });
      j++;
    }
  }
  const subs: Sub[] = [];
  const posOf = (op: Op) => {
    const t = op.a ?? op.d ?? '';
    const at = actual.toLowerCase().indexOf(t);
    return Math.round((at / Math.max(1, actual.length)) * 100);
  };
  for (let k = 0; k < ops.length; k++) {
    if (!ops[k].d && !ops[k].a) continue;
    const dels: string[] = [];
    const ins: string[] = [];
    while (k < ops.length && (ops[k].d || ops[k].a)) {
      if (ops[k].d) dels.push(ops[k].d!);
      if (ops[k].a) ins.push(ops[k].a!);
      k++;
    }
    const n = Math.max(dels.length, ins.length);
    for (let m = 0; m < n; m++) {
      const exp = dels[m] ?? '';
      const act = ins[m] ?? '';
      const kind = CJK_G.test(act)
        ? 'cjk'
        : exp && act && lev(exp, act) <= (exp.length > 3 ? 2 : 1)
          ? 'nearmiss'
          : 'paraphrase';
      subs.push({ expected: exp, actual: act, kind, pos_pct: posOf({ a: act, d: exp }) });
    }
  }
  return subs;
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

type Cell = {
  name: string;
  context_variant: 'short' | 'deepmax' | 'dirty';
  task: 'recite' | 'longform';
  provider: LlmProvider;
  model: string;
  temperature: number;
  n: number;
};

// 128 pre-registered: recite rows carry the substitution column, longform rows the CJK
// column at realistic output length; deepinfra vs fireworks at temp 0 is the fp4/bf16
// discriminator. H1 (mid-surrogate clip) stays as the tokenizer-repair control.
const CELLS: Cell[] = [
  {
    name: 'A1',
    context_variant: 'short',
    task: 'recite',
    provider: 'deepinfra',
    model: CHAT_MODEL,
    temperature: 0.2,
    n: 8,
  },
  {
    name: 'R1',
    context_variant: 'deepmax',
    task: 'recite',
    provider: 'deepinfra',
    model: CHAT_MODEL,
    temperature: 0,
    n: 24,
  },
  {
    name: 'R2',
    context_variant: 'deepmax',
    task: 'recite',
    provider: 'fireworks',
    model: CHAT_MODEL,
    temperature: 0,
    n: 8,
  },
  {
    name: 'L1',
    context_variant: 'deepmax',
    task: 'longform',
    provider: 'deepinfra',
    model: CHAT_MODEL,
    temperature: 0.2,
    n: 24,
  },
  {
    name: 'L2',
    context_variant: 'deepmax',
    task: 'longform',
    provider: 'deepinfra',
    model: CHAT_MODEL,
    temperature: 0,
    n: 24,
  },
  {
    name: 'L3',
    context_variant: 'deepmax',
    task: 'longform',
    provider: 'fireworks',
    model: CHAT_MODEL,
    temperature: 0,
    n: 12,
  },
  {
    name: 'L4',
    context_variant: 'deepmax',
    task: 'longform',
    provider: 'fireworks',
    model: CHAT_MODEL,
    temperature: 0.2,
    n: 12,
  },
  {
    name: 'G2',
    context_variant: 'deepmax',
    task: 'longform',
    provider: 'deepinfra',
    model: TASK_MODEL,
    temperature: 0.2,
    n: 8,
  },
  {
    name: 'H1',
    context_variant: 'dirty',
    task: 'recite',
    provider: 'deepinfra',
    model: CHAT_MODEL,
    temperature: 0.2,
    n: 8,
  },
];

const activeCells = CELLS.filter((c) => !cellFilter || cellFilter.split(',').includes(c.name)).map(
  (c) => ({
    ...c,
    n: pilot ? 1 : c.n,
  }),
);

const connector = (p: LlmProvider) =>
  p === 'fireworks'
    ? connectors.fireworks
    : p === 'deepinfra'
      ? connectors.deepinfra
      : connectors.fireworks;
// Providers serve the same model under different ids (Fireworks prefixes its account).
const hostModelId = (model: string, p: LlmProvider) => BACKEND_IDS[model]?.[p] ?? model;

async function main() {
  const client = new MongoClient(buildMongoUri());
  await client.connect();
  let deepPlanted: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  try {
    const db = client.db('tova');
    const user = await db.collection('users').findOne({ email: EMAIL });
    if (!user) throw new Error('user not found');
    const sessions = await db
      .collection('sessions')
      .find({ userId: user._id })
      .project({ _id: 1 })
      .toArray();
    const top = await db
      .collection('messages')
      .aggregate<{ _id: string | null; n: number }>([
        { $match: { sessionId: { $in: sessions.map((s) => s._id) } } },
        { $group: { _id: '$sessionId', n: { $sum: { $strLenCP: '$content' } } } },
        { $sort: { n: -1 } },
        { $limit: 4 },
      ])
      .toArray();
    if (!top.length || !top[0]._id) throw new Error('no sessions with messages');
    const docs = await db
      .collection('messages')
      .find({ sessionId: { $in: top.map((t) => new ObjectId(t._id!)) } })
      .sort({ timestamp: 1 })
      .project({ role: 1, content: 1, _id: 0 })
      .toArray();
    const windowed = windowedHistory(docs as { role?: string; content?: string | null }[]);
    const history = [...windowed].reverse().map((d) => ({
      role: (d.role ?? 'user') as 'system' | 'user' | 'assistant',
      content: d.content ?? '',
    }));
    const chars = history.reduce((a, m) => a + m.content.length, 0);
    console.log(`deepmax context: ${history.length} messages, ${chars} chars`);
    deepPlanted = [
      ...history,
      { role: 'user' as const, content: `Please save this passage for me:\n\n${CANARY}` },
      { role: 'assistant' as const, content: 'Saved — recite it back any time.' },
    ];
  } finally {
    await client.close();
  }

  const buildMessages = (cell: Cell) => {
    if (cell.context_variant === 'short')
      return [
        { role: 'system' as const, content: system },
        { role: 'user' as const, content: reciteInline },
      ];
    if (cell.context_variant === 'dirty') {
      // Cut through an astral surrogate pair to emulate the taskSequencer 2000-char slice shape.
      const withAstral = `${CANARY.slice(0, 400)} 𠮷 ${CANARY.slice(400)}`;
      const cutAt = withAstral.indexOf('𠮷') + 1;
      return [
        { role: 'system' as const, content: system },
        {
          role: 'user' as const,
          content: `Recite this passage exactly, verbatim, no commentary:\n\n${withAstral.slice(0, cutAt)}…`,
        },
      ];
    }
    const tail =
      cell.task === 'recite'
        ? { role: 'user' as const, content: reciteFromHistory }
        : { role: 'user' as const, content: longformFromHistory };
    return [{ role: 'system' as const, content: system }, ...deepPlanted, tail];
  };

  const runOne = async (cell: Cell, index: number): Promise<Row> => {
    const messages = buildMessages(cell);
    const completion = await connector(cell.provider).createCompletion({
      model: hostModelId(cell.model, cell.provider),
      messages,
      temperature: cell.temperature,
      max_tokens: cell.task === 'longform' ? 12000 : 4096,
    });
    const text = completion.choices[0]?.message?.content ?? '';
    const clean = stripFences(text);
    const recite = cell.task === 'recite';
    // Verbatim task: any word substitution vs the canary is a flip by definition; the
    // cjk/nearmiss/paraphrase tags are descriptive (BGE cosine cannot separate near-miss
    // from unrelated — calibrated at ~0.5 floor for both, see #420).
    const subs = recite ? diffWords(CANARY, clean) : [];
    const contextText = messages.map((m) => m.content).join('\n');
    const strays = [...clean.matchAll(CJK_G)].map((m) => {
      const at = m.index ?? 0;
      const echoed = contextText.includes(m[0]);
      return {
        expected: '',
        actual: m[0],
        kind: echoed ? 'cjk-echo' : 'cjk',
        pos_pct: Math.round((at / Math.max(1, clean.length)) * 100),
      };
    });
    const realStrays = strays.filter((s) => s.kind === 'cjk');
    return {
      cell: cell.name,
      context_variant: cell.context_variant,
      task: cell.task,
      temperature: cell.temperature,
      provider: cell.provider,
      model: cell.model,
      output_chars: text.length,
      finish_reason: completion.choices[0]?.finishReason,
      stray_chars: realStrays.length,
      cjk_substitutions: subs.filter((s) => s.kind === 'cjk' && !contextText.includes(s.actual))
        .length,
      nearmiss_substitutions: subs.filter((s) => s.kind === 'nearmiss').length,
      paraphrase_words: subs.filter((s) => s.kind === 'paraphrase').length,
      position_histogram: histogram(realStrays.map((s) => s.pos_pct)),
      examples: [...realStrays, ...subs.filter((s) => s.kind !== 'paraphrase')].slice(0, 5),
    };
  };

  const jobs = activeCells.flatMap((cell) =>
    Array.from({ length: cell.n }, (_, i) => ({ cell, i })),
  );
  const results: Row[] = [];
  const total = jobs.length;
  let done = 0;
  const pool = Array.from({ length: concurrency }, async () => {
    while (jobs.length) {
      const job = jobs.shift();
      if (!job) break;
      try {
        results.push(await runOne(job.cell, job.i));
      } catch (err) {
        console.error(
          `[${job.cell.name}#${job.i}] failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      done++;
      if (done % 10 === 0 || done === total) console.log(`${done}/${total}`);
    }
  });
  await Promise.all(pool);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  fs.writeFileSync(out, results.map((r) => JSON.stringify(r)).join('\n'));

  const byCell = new Map<string, Row[]>();
  for (const r of results) {
    const list = byCell.get(r.cell) ?? [];
    list.push(r);
    byCell.set(r.cell, list);
  }
  console.log(`\nwrote ${results.length} rows to ${out}\n`);
  for (const [cell, rows] of [...byCell].sort()) {
    const flips = rows.filter(
      (r) => r.stray_chars > 0 || r.cjk_substitutions > 0 || r.nearmiss_substitutions > 0,
    ).length;
    console.log(
      `${cell} (${rows[0].task}, temp=${rows[0].temperature}, ${rows[0].provider}): n=${rows.length} flipMsgs=${flips} strays=${rows.reduce((a, r) => a + r.stray_chars, 0)} cjkSubs=${rows.reduce((a, r) => a + r.cjk_substitutions, 0)} nearMiss=${rows.reduce((a, r) => a + r.nearmiss_substitutions, 0)} avgOut=${Math.round(rows.reduce((a, r) => a + r.output_chars, 0) / rows.length)}`,
    );
  }
}

export { diffWords, CANARY as CANARY_TEST_ONLY, histogram, stripFences };

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1])))
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
