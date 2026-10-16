import 'dotenv/config';
import type { LlmProvider } from '../apps/server/src/main/services/llmTypes';
import { runModelComparison } from '../apps/server/src/main/services/modelCompare';
import { ROSTER_SEED } from '../apps/server/src/main/services/rosterConfig';

/*
 * #129 one-off eval: run a single prompt against the existing agent on
 * several underlying models and print the answers side by side, informally
 * scored by reading them. Not part of CI; the same comparison is available
 * in the browser via the admin "Compare" view (POST /api/admin/model-compare),
 * which resolves to the same `runModelComparison` service. This script is
 * the parent for a future "sophisticated routing policy" eval harness: a
 * routing rule is only changed after it has been compared here.
 *
 * Usage:
 *   npx tsx scripts/eval-model-compare.ts "prompt text" --models \
 *     deepinfra/zai-org/GLM-5.3-Flash,fireworks/accounts/fireworks/models/glm-5p3-flash
 * Model refs are `<provider>/<model>`; provider is groq|deepinfra|fireworks.
 * Defaults (#236): the fixed roster on both its providers.
 * Needs the relevant provider API keys (DEEPINFRA_API_KEY, FIREWORKS_API_KEY).
 */

const DEFAULT_REFS = ROSTER_SEED.flatMap((model) =>
  model.providers.map((p) => `${p.provider}/${p.modelId}`),
);

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
