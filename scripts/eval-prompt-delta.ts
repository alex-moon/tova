// One-off eval for #384 follow-up: prompt-delta probe on DeepSeek. Same session, same
// read-back turn, status-quo history in every arm; each arm changes exactly one thing
// in the system prompt (or the history size, for P4). Usage:
//   npx tsx scripts/eval-prompt-delta.ts [--reps 5]
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

const reps = Math.max(1, Number(process.argv[process.argv.indexOf('--reps') + 1] ?? '') || 5);

type HistoryTurn = { role: string; content: string; timestamp?: Date };

const IDENTITY_SWAP =
  'You are Tova, a capable personal agent working directly in the user’s workspace — ' +
  'their files, their conversations, their tasks. You get things done by acting: when a ' +
  'request touches their material, you run the tool rather than describe it. You are ' +
  'warm and direct, and you never narrate work you have not done. If asked what model ' +
  'or AI you’re built on, answer simply: you’re Tova. Do not name underlying providers ' +
  'or models.';

const EPISTEMICS_NEEDLE = 'Trust yourself for what lives in you';
const EPISTEMICS_SWAP =
  'Trust yourself for what lives in you — reasoning, the date and time you’re given, ' +
  'general understanding. The person’s own material is not inside you: the only part of ' +
  'it you have is what surfaces in this conversation, and anything beyond that needs a ' +
  'tool.';
const READ_RULE =
  'When a request depends on what a file currently says, call `read_file` before ' +
  'answering — even if you are certain you remember its contents; memory of a file is ' +
  'not the file. Never state file contents you have not read in this turn.';

/* Each edit throws when its needle is missing so an inert arm can never pass silently. */
const swapIdentity = (system: string): string => {
  const parts = system.split('\n\n');
  if (!parts[0].startsWith('You are Tova')) throw new Error('identity paragraph not found');
  parts[0] = IDENTITY_SWAP;
  return parts.join('\n\n');
};

const tightenEpistemics = (system: string): string => {
  const parts = system.split('\n\n');
  const idx = parts.findIndex((p) => p.startsWith(EPISTEMICS_NEEDLE));
  if (idx === -1) throw new Error('epistemics paragraph not found');
  const swapped = parts[idx].replace(/^Trust yourself.*?material\./s, EPISTEMICS_SWAP);
  if (swapped === parts[idx]) throw new Error('epistemics sentence not replaced');
  parts[idx] = swapped;
  return parts.join('\n\n');
};

const addReadRule = (system: string): string => {
  const parts = system.split('\n\n');
  const idx = parts.findIndex((p) => p.startsWith(EPISTEMICS_NEEDLE));
  if (idx === -1) throw new Error('epistemics paragraph not found');
  parts.splice(idx + 1, 0, READ_RULE);
  return parts.join('\n\n');
};

const CONNECTORS: Record<string, LlmConnector | undefined> = {
  groq: groqConnector,
  deepinfra: deepinfraConnector,
  fireworks: fireworksConnector,
};

interface RepResult {
  arm: string;
  toolsCalled: string[];
  flagged: boolean;
  reply: string;
  error?: string;
}

const runRep = async (
  arm: string,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  ref: { provider: LlmProvider; model: string; contextLength?: number },
  sessionId: string,
): Promise<RepResult> => {
  const options: CompletionOptions = {
    provider: ref.provider,
    model: ref.model,
    // No userId: tools answer 'unavailable', so the probe cannot write to the real
    // library; invocation is decided before the call, so the metric stays clean.
    messages,
    max_tokens: outputTokensFor(ref.contextLength, promptCharsFrom(messages)),
  };
  const connector = CONNECTORS[ref.provider];
  if (!connector) throw new Error(`unknown provider ${ref.provider}`);
  const completion = await connector.createCompletion(options);
  const reply = completion.choices[0]?.message?.content ?? '';
  const toolsCalled = (completion.toolResults ?? []).map((r) => r.name);
  const verdict = reply.trim() ? await classifyAssistantTurn(reply, toolsCalled, sessionId) : null;
  return { arm, toolsCalled, flagged: verdict?.flagged ?? false, reply };
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

  const system = buildSystemContent(user, false, user.settings?.timezone, workspaceBlock, taskBlock);
  const history = messagesFromPersistedHistory(newestFirst, user.settings?.timezone).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content as string,
  }));

  // P4: last exchange + the new turn, prompt unchanged.
  const p4History = history.slice(-3);
  const base = (systemContent: string, turns = history) => [
    { role: 'system' as const, content: systemContent },
    ...turns,
  ];

  const arms: { name: string; messages: ReturnType<typeof base> }[] = [
    { name: 'P0-baseline', messages: base(system) },
    { name: 'P1-agentic-identity', messages: base(swapIdentity(system)) },
    { name: 'P2-epistemics-closed', messages: base(tightenEpistemics(system)) },
    { name: 'P3-read-rule', messages: base(addReadRule(system)) },
    { name: 'P4-minimal-history', messages: base(system, p4History) },
  ];

  const ref = (await listRoster())
    .flatMap((m) => m.providers.map((p) => ({ provider: p.provider, model: m.modelId, contextLength: m.contextLength })))
    .find((r) => r.model.includes(MODEL_FILTER) && r.provider === PROVIDER_FILTER);
  if (!ref) throw new Error('no deepinfra DeepSeek ref on the roster');

  console.log(`session ${sessionId} · ${arms.length} arms · ${reps} reps · ${ref.provider}/${ref.model}\n`);
  const results: RepResult[] = [];
  for (const { name, messages } of arms) {
    for (let i = 0; i < reps; i += 1) {
      try {
        const r = await runRep(name, messages, ref, sessionId);
        results.push(r);
        const did = r.toolsCalled.length ? `called ${[...new Set(r.toolsCalled)].join(',')}` : 'no tool call';
        console.log(`[${name}] #${i + 1}: ${did}${r.flagged ? ' · FLAGGED' : ''} — ${r.reply.slice(0, 100).replace(/\n/g, ' ')}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ arm: name, toolsCalled: [], flagged: false, reply: '', error: msg });
        console.error(`[${name}] #${i + 1}: ERROR ${msg}`);
      }
    }
  }

  console.log('\n=== scoreboard (invocation / claim-flag) ===');
  for (const arm of new Set(results.map((r) => r.arm))) {
    const rows = results.filter((r) => r.arm === arm && !r.error);
    const invoked = rows.filter((r) => r.toolsCalled.length > 0).length;
    const flagged = rows.filter((r) => r.flagged).length;
    console.log(`${arm}: ${rows.length ? `${invoked}/${rows.length} invoked · ${flagged}/${rows.length} flagged` : 'no successful reps'}`);
  }
  await mongoose.disconnect();
}

async function listRosterRefs(): Promise<{ provider: LlmProvider; model: string; contextLength?: number }[]> {
  const { listRoster } = await import('../apps/server/src/main/services/rosterConfig');
  const roster = await listRoster();
  return roster.flatMap((m) =>
    m.providers.map((p) => ({ provider: p.provider, model: m.modelId, contextLength: m.contextLength })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
