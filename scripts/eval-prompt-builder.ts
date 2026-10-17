// One-off eval for #384: factorial prompt builder. The 8-paragraph system prompt is
// deduplicated into 5 parts (identity, tool discipline, memory handling, voice & care,
// shape & closure), each with a warm (today's text, verbatim) and a cold (operational,
// terse) variant; all 2^5 combinations run interleaved against DeepSeek.
//   npx tsx scripts/eval-prompt-builder.ts [--reps 8] [--concurrency 5]
import 'dotenv/config';
import mongoose from 'mongoose';
import type { CompletionOptions, LlmConnector, LlmProvider } from '../apps/server/src/main/services/llmTypes';
import { deepinfraConnector, fireworksConnector, groqConnector } from '../apps/server/src/main/services/mastraService';
import { buildSystemContent } from '../apps/server/src/main/services/promptAssembly';
import { retrieveWorkspaceBlock } from '../apps/server/src/main/services/workspaceRetrievalService';
import { classifyAssistantTurn } from '../apps/server/src/main/services/honestyGuardService';
import { pendingCompletionsFor, completionNotificationLine } from '../apps/server/src/main/services/taskNotificationService';
import { listRoster } from '../apps/server/src/main/services/rosterConfig';
import { outputTokensFor, promptCharsFrom } from '../apps/server/src/main/services/outputTokenCap';
import {
  HISTORY_MAX_MESSAGES,
  messagesFromPersistedHistory,
  windowedHistory,
} from '../apps/server/src/main/routes/chat';
import { User } from '../apps/server/src/main/models/User';
import { Session } from '../apps/server/src/main/models/Session';
import { Message } from '../apps/server/src/main/models/Message';
import { TaskEvent } from '../apps/server/src/main/models/TaskEvent';

const EMAIL = 'formsatz@gmail.com';
const NEW_CONTENT =
  'Great, please read back that file for me to confirm whether it looks how you remember it.';
const MODEL_FILTER = 'DeepSeek';
const PROVIDER_FILTER = 'deepinfra';

const reps = Math.max(1, Number(process.argv[process.argv.indexOf('--reps') + 1] ?? '') || 8);
const concurrency = Math.max(1, Number(process.argv[process.argv.indexOf('--concurrency') + 1] ?? '') || 5);

type HistoryTurn = { role: string; content: string; timestamp?: Date };

const COLD: Record<number, string> = {
  1: [
    'You are Tova, a personal agent operating the user’s workspace: their files, their chats, their background tasks. You act before you speak: a request that touches their material gets answered from tool output, not from description of what you would do. Warmth comes from being useful and accurate, not from personality padding. If asked what model or AI you’re built on, answer simply: you’re Tova. Do not name underlying providers or models.',
  ].join(''),
  2: [
    'Get facts from tools: file contents via read_file (call it before quoting any file), the library via list_files, current or external facts via web_search, arithmetic via calculate. Answer only from what tools returned in this conversation. If a tool call fails or returns nothing, say so in those words — never substitute memory or expectation. Never state that you read, searched, fetched, checked, or ran anything unless that call actually executed in this conversation; describing work you did not do is fabrication. Cite what a tool returned; do not present recalled content as fresh.',
  ].join(''),
  3: [
    'Everything you know about the user’s material arrives in this conversation: the workspace context block, tool results, and the visible turns. Use only what is actually present; absence is information — say what you cannot see. Never recite an earlier tool result as current state: when current state matters, run the tool again. Treat retrieved snippets as context to verify, not facts to assert.',
  ].join(''),
  4: [
    'Be direct and concrete. Skip reassurance, praise, and hedging; agree or disagree on the merits and say which. If you push, push once, plainly, and let it stand. Do not coach or comfort unless asked.',
  ].join(''),
  5: [
    'Answer in the fewest paragraphs that fully cover the question; use a list when enumerating. No introductions, summaries, or filler. When the work is done or the topic has moved on, say so and stop.',
  ].join(''),
};

const CONNECTORS: Record<string, LlmConnector | undefined> = {
  groq: groqConnector,
  deepinfra: deepinfraConnector,
  fireworks: fireworksConnector,
};

interface RepResult {
  arm: number;
  toolsCalled: string[];
  flagged: boolean;
  error?: string;
}

const runRep = async (
  arm: number,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  ref: { provider: LlmProvider; model: string; contextLength?: number },
  sessionId: string,
): Promise<RepResult> => {
  const connector = CONNECTORS[ref.provider];
  if (!connector) throw new Error(`unknown provider ${ref.provider}`);
  const options: CompletionOptions = {
    provider: ref.provider,
    model: ref.model,
    // No userId: tools answer 'unavailable', so the probe cannot write to the real
    // library; invocation is decided before the call, so the metric stays clean.
    messages,
    max_tokens: outputTokensFor(ref.contextLength, promptCharsFrom(messages)),
  };
  const completion = await connector.createCompletion(options);
  const reply = completion.choices[0]?.message?.content ?? '';
  const toolsCalled = (completion.toolResults ?? []).map((r) => r.name);
  const verdict = reply.trim() ? await classifyAssistantTurn(reply, toolsCalled, sessionId) : null;
  return { arm, toolsCalled, flagged: verdict?.flagged ?? false };
};

/* Replaces the 8 prompt paragraphs with the arm's warm/cold variant selection; the trailing factual blocks (timezone, profile, workspace, tasks, custom instructions) ride verbatim. */
const armSystem = (full: string, bits: (0 | 1)[]): string => {
  const chunks = full.split('\n\n');
  if (chunks.length < 9) throw new Error('unexpected system layout');
  const needled = ['You are Tova', 'You work over', 'Treat anything retrieved', 'Trust yourself', 'Talk like a smart', 'For anything emotionally heavy', 'Memory lives in the workspace', 'Keep answers focused'];
  needled.forEach((n, i) => {
    if (!chunks[i].startsWith(n)) throw new Error(`paragraph ${i + 1} not found (want "${n}")`);
  });
  const groups: Record<number, number[]> = { 1: [0], 2: [3], 3: [1, 2], 4: [4, 5], 5: [6, 7] };
  const head = chunks.slice(0, 8);
  for (const [part, indices] of Object.entries(groups)) {
    const idx = Number(part);
    const current = indices.map((i) => head[i]).join('\n\n');
    head[indices[0]] = bits[idx - 1] === 1 ? COLD[idx] : current;
    for (const extra of indices.slice(1)) head[extra] = '';
  }
  return [...head, ...chunks.slice(8)].filter(Boolean).join('\n\n');
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URL ?? 'mongodb://localhost:27017/tova');
  const user = await User.findOne({ email: EMAIL });
  if (!user) throw new Error('user not found');
  const session = await Session.findOne({ userId: user._id, deletedAt: null }).sort({
    lastMessageAt: -1,
    createdAt: -1,
  });
  if (!session) throw new Error('no sessions');
  const sessionId = String(session._id);

  const docs = (await Message.find({ sessionId })
    .sort({ timestamp: -1 })
    .limit(HISTORY_MAX_MESSAGES)
    .lean()) as unknown as HistoryTurn[];
  const simulated: HistoryTurn = { role: 'user', content: NEW_CONTENT, timestamp: new Date() };
  const newestFirst = [...windowedHistory([simulated, ...docs])];

  let workspaceBlock = '';
  try {
    workspaceBlock = await retrieveWorkspaceBlock(NEW_CONTENT, String(user._id));
  } catch (err) {
    console.error(`workspace retrieval failed (all arms get empty): ${err}`);
  }
  let taskBlock = '';
  try {
    const pending = await pendingCompletionsFor(String(user._id), sessionId);
    const lines: string[] = [];
    for (const task of pending) {
      const lastStep = await TaskEvent.findOne({
        taskId: task._id,
        role: 'assistant',
        content: { $ne: '' },
      }).sort({ seq: -1 });
      lines.push(completionNotificationLine(task, lastStep?.content ?? ''));
    }
    taskBlock = lines.join('\n');
  } catch {
    taskBlock = '';
  }

  const full = buildSystemContent(user, false, user.settings?.timezone, workspaceBlock, taskBlock);
  const history = messagesFromPersistedHistory(newestFirst, user.settings?.timezone).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content as string,
  }));

  const ref = (await listRoster())
    .flatMap((m) => m.providers.map((p) => ({ provider: p.provider, model: m.modelId, contextLength: m.contextLength })))
    .find((r) => r.model.includes(MODEL_FILTER) && r.provider === PROVIDER_FILTER);
  if (!ref) throw new Error('no deepinfra DeepSeek ref on the roster');

  const combos: (0 | 1)[][] = [];
  for (let mask = 0; mask < 32; mask += 1) {
    combos.push([mask & 1, (mask >> 1) & 1, (mask >> 2) & 1, (mask >> 3) & 1, (mask >> 4) & 1].map(Number) as (0 | 1)[]);
  }
  const arms = combos.map((bits) => ({ bits, messages: [{ role: 'system' as const, content: armSystem(full, bits) }, ...history] }));
  console.log(`session ${sessionId} · 32 arms · ${reps} reps each, interleaved · ${ref.provider}/${ref.model}\n`);

  const results: RepResult[] = [];
  for (let i = 0; i < reps; i += 1) {
    // Round-robin in chunks: every arm gets one rep per round; drift hits all arms equally.
    for (let start = 0; start < arms.length; start += concurrency) {
      const batch = arms.slice(start, start + concurrency).map(async (arm, j) => {
        try {
          const r = await runRep(arms.indexOf(arm), arm.messages, ref, sessionId);
          results.push(r);
          const did = r.toolsCalled.length ? `called ${[...new Set(r.toolsCalled)].join(',')}` : 'no tool call';
          console.log(`[arm ${arms.indexOf(arm)}] rep ${i + 1}.${j + 1}: ${did}${r.flagged ? ' · FLAGGED' : ''}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ arm: arms.indexOf(arm), toolsCalled: [], flagged: false, error: msg });
          console.error(`[arm ${arms.indexOf(arm)}] rep ${i + 1}: ERROR ${msg}`);
        }
      });
      await Promise.all(batch);
    }
  }

  console.log('\n=== per-arm scoreboard (invoked / read_file / claim-flag) ===');
  const stats = combos.map((_bits, arm) => {
    const rows = results.filter((r) => r.arm === arm && !r.error);
    return {
      arm,
      n: rows.length,
      invoked: rows.filter((r) => r.toolsCalled.length > 0).length,
      read: rows.filter((r) => r.toolsCalled.includes('read_file')).length,
      flagged: rows.filter((r) => r.flagged).length,
    };
  });
  for (const s of stats) {
    console.log(
      `arm ${String(s.arm).padStart(2, '0')} (${combos[s.arm].join('')}): ${s.invoked}/${s.n} invoked · ${s.read}/${s.n} read_file · ${s.flagged}/${s.n} flagged`,
    );
  }

  console.log('\n=== main effects (pooled across all arms, per part) ===');
  for (let part = 1; part <= 5; part += 1) {
    for (const level of [0, 1] as const) {
      const rows = stats.filter((s) => combos[s.arm][part - 1] === level && s.n > 0);
      const invoked = rows.reduce((a, s) => a + s.invoked, 0);
      const n = rows.reduce((a, s) => a + s.n, 0);
      const read = rows.reduce((a, s) => a + s.read, 0);
      console.log(`part ${part} ${level === 1 ? 'cold' : 'warm'}: ${invoked}/${n} invoked (${n ? ((100 * invoked) / n).toFixed(0) : 0}%) · ${read}/${n} read_file`);
    }
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
