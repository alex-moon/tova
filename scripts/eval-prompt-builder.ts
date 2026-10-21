// One-off eval: factorial prompt builder, all warm/cold arm combos.
// @see #384
//   npx tsx scripts/eval-prompt-builder.ts [--reps 8] [--concurrency 5]
import 'dotenv/config';
import mongoose from 'mongoose';
import type {
  CompletionOptions,
  LlmConnector,
  LlmProvider,
} from '../apps/server/src/main/services/llm/llmTypes';
import {
  deepinfraConnector,
  fireworksConnector,
  groqConnector,
} from '../apps/server/src/main/services/llm/mastraService';
import { buildSystemContent } from '../apps/server/src/main/services/llm/promptAssembly';
import { retrieveWorkspaceBlock } from '../apps/server/src/main/services/workspace/workspaceRetrievalService';
import { classifyAssistantTurn } from '../apps/server/src/main/services/llm/honestyGuardService';
import {
  pendingCompletionsFor,
  completionNotificationLine,
} from '../apps/server/src/main/services/task/taskNotificationService';
import { chatBackends, contextLengthFor } from '../apps/server/src/main/services/model/modelDefaults';
import { outputTokensFor, promptCharsFrom } from '../apps/server/src/main/services/llm/outputTokenCap';
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
const MODELS = ['DeepSeek', 'GLM'];
const PROVIDER_FILTER = 'deepinfra';

const reps = Math.max(1, Number(process.argv[process.argv.indexOf('--reps') + 1] ?? '') || 8);
const concurrency = Math.max(
  1,
  Number(process.argv[process.argv.indexOf('--concurrency') + 1] ?? '') || 5,
);

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
  toolsCalled: string[];
  flagged: boolean;
  error?: string;
}

const runRep = async (
  bits: (0 | 1)[],
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  ref: { provider: LlmProvider; model: string; contextLength?: number },
  sessionId: string,
): Promise<RepResult> => {
  const connector = CONNECTORS[ref.provider];
  if (!connector) throw new Error(`unknown provider ${ref.provider}`);
  const options: CompletionOptions = {
    provider: ref.provider,
    model: ref.model,
    // No userId: tools answer 'unavailable'; the metric is invocation.
    messages,
    max_tokens: outputTokensFor(ref.contextLength, promptCharsFrom(messages)),
  };
  const completion = await connector.createCompletion(options);
  const reply = completion.choices[0]?.message?.content ?? '';
  const toolsCalled = (completion.toolResults ?? []).map((r) => r.name);
  const verdict = reply.trim() ? await classifyAssistantTurn(reply, toolsCalled, sessionId) : null;
  return { toolsCalled, flagged: verdict?.flagged ?? false };
};

/* Swaps the 8 prompt paragraphs for the arm's warm/cold variants. */
const armSystem = (full: string, bits: (0 | 1)[]): string => {
  const chunks = full.split('\n\n');
  if (chunks.length < 9) throw new Error('unexpected system layout');
  const needled = [
    'You are Tova',
    'You work over',
    'Treat anything retrieved',
    'Trust yourself',
    'Talk like a smart',
    'For anything emotionally heavy',
    'Memory lives in the workspace',
    'Keep answers focused',
  ];
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

  const rosterRefs = chatBackends()
    .map((b) => ({
      provider: b.provider,
      model: b.modelId,
      contextLength: contextLengthFor(b.modelId),
    }))
    .filter((r) => MODELS.some((name) => r.model.includes(name)) && r.provider === PROVIDER_FILTER);
  if (rosterRefs.length < MODELS.length)
    throw new Error(`wanted ${MODELS.length} refs, roster offered ${rosterRefs.length}`);

  // Confirm run: baseline (00000) vs cold-epistemics+warm-voice (mask 7).
  const arms = [0, 7].map((mask) => {
    const bits = [mask & 1, (mask >> 1) & 1, (mask >> 2) & 1, (mask >> 3) & 1, (mask >> 4) & 1] as (
      0 | 1
    )[];
    return {
      bits,
      mask,
      messages: [{ role: 'system' as const, content: armSystem(full, bits) }, ...history],
    };
  });
  const cells = rosterRefs.flatMap((ref) =>
    arms.map((arm) => ({ ref, arm, key: `${ref.model}·arm${arm.mask}` })),
  );
  console.log(
    `session ${sessionId} · ${arms.length} arms × ${rosterRefs.length} models · ${reps} reps each, interleaved\n`,
  );

  const results: (RepResult & { key: string })[] = [];
  for (let i = 0; i < reps; i += 1) {
    for (let start = 0; start < cells.length; start += concurrency) {
      const batch = cells.slice(start, start + concurrency).map(async (cell, j) => {
        try {
          const r = await runRep(cell.arm.bits, cell.arm.messages, cell.ref, sessionId);
          results.push({ ...r, key: cell.key });
          const did = r.toolsCalled.length
            ? `called ${[...new Set(r.toolsCalled)].join(',')}`
            : 'no tool call';
          console.log(
            `[${cell.key}] rep ${i + 1}.${j + 1}: ${did}${r.flagged ? ' · FLAGGED' : ''}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ toolsCalled: [], flagged: false, error: msg, key: cell.key });
          console.error(`[${cell.key}] rep ${i + 1}: ERROR ${msg}`);
        }
      });
      await Promise.all(batch);
    }
  }

  console.log('\n=== confirm scoreboard (invoked / read_file / claim-flag) ===');
  for (const model of new Set(results.map((r) => r.key.split('·')[0]))) {
    const [base, cand] = [0, 7].map((mask) => {
      const rows = results.filter((r) => r.key === `${model}·arm${mask}` && !r.error);
      return {
        n: rows.length,
        invoked: rows.filter((r) => r.toolsCalled.length > 0).length,
        read: rows.filter((r) => r.toolsCalled.includes('read_file')).length,
        flagged: rows.filter((r) => r.flagged).length,
      };
    });
    const show = (label: string, s: typeof base) =>
      console.log(
        `${model} ${label}: ${s.invoked}/${s.n} invoked · ${s.read}/${s.n} read_file · ${s.flagged}/${s.n} flagged`,
      );
    show('baseline', base);
    show('candidate', cand);
    // Two-proportion z on the invocation gap (unreliable at 0 or 1 cells).
    if (base.n > 0 && cand.n > 0) {
      const p1 = base.invoked / base.n;
      const p2 = cand.invoked / cand.n;
      const p = (base.invoked + cand.invoked) / (base.n + cand.n);
      const se = Math.sqrt(p * (1 - p) * (1 / base.n + 1 / cand.n));
      const z = se > 0 ? (p2 - p1) / se : 0;
      console.log(`${model} Δ invoked: ${(100 * (p2 - p1)).toFixed(0)}pt (z ≈ ${z.toFixed(2)})`);
    }
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
