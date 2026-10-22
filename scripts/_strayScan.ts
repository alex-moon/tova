import 'dotenv/config';
import fs from 'node:fs';
import { MongoClient } from 'mongodb';
import { buildMongoUri } from '../apps/shared/src/main/mongoUri';

const CJK =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF66-\uFF9D\u3000-\u303F]/g;

interface Hit {
  char: string;
  codepoint: string;
  pos: number | undefined;
  pct: number;
  before: string;
  after: string;
}

interface Finding extends Hit {
  kind: 'message' | 'taskEvent';
  model?: string;
  provider?: string;
  step?: number;
  at: Date | undefined;
}

const scan = (text: string): Hit[] => {
  const hits: Hit[] = [];
  for (const m of text.matchAll(CJK)) {
    const at = m.index;
    if (at === undefined) continue;
    hits.push({
      char: m[0],
      codepoint: m[0].codePointAt(0)!.toString(16),
      pos: at,
      pct: Math.round((at / text.length) * 100),
      before: text.slice(Math.max(0, at - 80), at),
      after: text.slice(at + 1, at + 80),
    });
  }
  return hits;
};

async function main() {
  const client = new MongoClient(buildMongoUri());
  try {
    await client.connect();
    const db = client.db('tova');
    const user = await db.collection('users').findOne({ email: 'formsatz@gmail.com' });
    if (!user) throw new Error('user not found');

    const sessions = await db
      .collection('sessions')
      .find({ userId: user._id })
      .project({ _id: 1 })
      .toArray();
    const sessIds = sessions.map((s) => s._id);

    const msgs = await db
      .collection('messages')
      .find({ sessionId: { $in: sessIds }, role: 'assistant' })
      .project({ sessionId: 1, content: 1, modelName: 1, timestamp: 1 })
      .toArray();

    const tasks = await db.collection('tasks').find({ userId: user._id }).project({ _id: 1 }).toArray();
    const events = tasks.length
      ? await db
          .collection('taskevents')
          .find({ taskId: { $in: tasks.map((t) => t._id) }, role: { $ne: 'user' } })
          .project({ content: 1, model: 1, provider: 1, step: 1 })
          .toArray()
      : [];

    const findings: Finding[] = [];
    for (const m of msgs)
      for (const hit of scan(m.content || ''))
        findings.push({ kind: 'message', model: m.modelName, at: m.timestamp, ...hit });
    for (const e of events)
      for (const hit of scan(e.content || ''))
        findings.push({ kind: 'taskEvent', model: e.model, provider: e.provider, step: e.step, ...hit });

    const replacementDocs = [...msgs, ...events].filter((d) => d.content?.includes('\uFFFD')).length;

    const byModel = await db
      .collection('messages')
      .aggregate([
        { $match: { sessionId: { $in: sessIds }, role: 'assistant' } },
        { $group: { _id: '$modelName', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ])
      .toArray();

    console.log(
      JSON.stringify(
        {
          userSessions: sessions.length,
          assistantMessages: msgs.length,
          taskEvents: events.length,
          replacementCharDocs: replacementDocs,
          byModel,
          strayFindings: findings.length,
          modelsInStrays: [...new Set(findings.map((f) => f.model))],
          findings: findings.slice(0, 12),
        },
        null,
        2,
      ),
    );
    fs.writeFileSync('/tmp/opencode/stray-scan.json', JSON.stringify(findings, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
