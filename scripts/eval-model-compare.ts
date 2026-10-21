import 'dotenv/config';
import type { LlmProvider } from '../apps/server/src/main/services/llm/llmTypes';
import { runModelComparison } from '../apps/server/src/main/services/model/modelCompare';
import {
  chatBackends,
  TASK_MODEL,
} from '../apps/server/src/main/services/model/modelDefaults';

/* One-off eval: one prompt against several models side by side. */
// @see #129 #236

const DEFAULT_REFS = [
  ...chatBackends().map((b) => `${b.provider}/${b.modelId}`),
  `deepinfra/${TASK_MODEL}`,
];

interface Args {
  prompt: string;
  refs: { provider: LlmProvider; model: string }[];
}

const parseArgs = (): Args | { usage: string } => {
  const argv = process.argv.slice(2);
  const promptJoiner = argv.findIndex((a) => !a.startsWith('--'));
  if (promptJoiner === -1) {
    return { usage: 'usage: npx tsx scripts/eval-model-compare.ts "<prompt>" [--models p/m,p/m]' };
  }
  const prompt = argv[promptJoiner];
  const modelsFlagIdx = argv.indexOf('--models');
  const modelsRaw =
    modelsFlagIdx !== -1 && argv[modelsFlagIdx + 1] ? argv[modelsFlagIdx + 1] : null;
  const refStrings = modelsRaw ? modelsRaw.split(',') : DEFAULT_REFS;
  const refs: { provider: LlmProvider; model: string }[] = [];
  for (const ref of refStrings) {
    const sep = ref.indexOf('/');
    const provider = sep === -1 ? '' : ref.slice(0, sep);
    if (provider !== 'groq' && provider !== 'deepinfra' && provider !== 'fireworks') {
      return {
        usage: `invalid model ref "${ref}" (want <provider>/<model>, provider groq|deepinfra|fireworks)`,
      };
    }
    refs.push({ provider, model: ref.slice(sep + 1) });
  }
  return { prompt, refs };
};

const main = async (): Promise<void> => {
  const parsed = parseArgs();
  if ('usage' in parsed) {
    console.error(parsed.usage);
    process.exit(1);
  }
  const { prompt, refs } = parsed;
  console.log(`prompt: ${prompt}\n`);
  const run = await runModelComparison(
    prompt,
    refs.map((r) => ({ ...r, contextLength: undefined })),
  );
  for (const res of run.results) {
    console.log(`=== ${res.provider}/${res.model} (${(res.latencyMs / 1000).toFixed(1)}s)`);
    if (res.error) console.log(`ERROR: ${res.error}\n`);
    else console.log(`${res.answer ?? '(empty)'}\n`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
