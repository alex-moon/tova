/*
 * Throwaway eval for ticket #17 task 10 (model choice for prompt
 * classification). Not part of the production code or CI: calls the
 * DeepInfra OpenAI-compatible chat endpoint directly over HTTP with the
 * same prompt + max_tokens the production path uses in
 * metricsService.classifyPromptDimensions, then scores each candidate
 * with the production parser (parseLlmFlags).
 *
 * Usage: set DEEPINFRA_API_KEY in the environment and run
 *   npx tsx scripts/eval-classify-models.ts
 */
import { parseLlmFlags } from '../src/server/services/metricsService';

const CANDIDATES = [
  'google/gemma-3-4b-it',
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  'Qwen/Qwen3.5-9B',
  'google/gemma-3-12b-it',
  'mistralai/Mistral-Nemo-Instruct-2407',
];

const maxTokens = 100;

const LLM_PROMPT =
  'Classify the user prompt below. Reply with ONLY one JSON object and nothing else, ' +
  'with exactly these keys: {"emotional": true|false, "technical": true|false, ' +
  '"abstract": true|false, "sentiment": "positive"|"negative"|"neutral", "openEnded": true|false}. ' +
  '"emotional": the prompt is about feelings or personal life rather than a task. ' +
  '"technical": the prompt uses engineering or domain jargon. ' +
  '"abstract": the prompt is strategic/high-level rather than a concrete step-by-step task. ' +
  '"sentiment": the overall tone of the prompt. ' +
  '"openEnded": true if it invites an open discussion, false if it is a one-shot task.';

// ~20 representative prompts matching the production distribution mix.
const PROMPTS = [
  'Hello!',
  'Yes, please continue.',
  'Tell me more about that.',
  'Can you summarize this in one sentence?',
  'Write a haiku about rain.',
  'What is the capital of France?',
  'Draft a short apology email to a client for a late delivery.',
  'How does HTTP keep-alive work?',
  'Refactor this function to use a switch statement: if (x === 1)...',
  'My teammate keeps ignoring my PR comments and it is really frustrating. What should I do?',
  'Design a migration plan from our MySQL monolith to microservices in stages.',
  'Is consciousness reducible to computation in your view?',
  'Fix this crash: Cannot read properties of undefined (reading "map")',
  'Explain the tradeoffs between optimistic and pessimistic locking.',
  'Write a SQL query that ranks customers by lifetime spend with running totals.',
  'Help me write a heartfelt birthday message for my sister.',
  'What does the product roadmap suggest for enterprise readiness?',
  'Add rate limiting to the public API endpoints.',
  'Write a pytest fixture that seeds a test database with three users.',
  'I feel anxious about launching next week. Any advice?',
];

interface Result {
  model: string;
  parsed: number;
  fullyParsed: number;
  truncations: number;
  meanLatencyMs: number;
}

const apiKey = process.env.DEEPINFRA_API_KEY;
if (!apiKey) {
  console.error('DEEPINFRA_API_KEY not set');
  process.exit(1);
}

const run = async (model: string): Promise<Result> => {
  let parsed = 0;
  let fullyParsed = 0;
  let truncations = 0;
  const latencies: number[] = [];
  for (const prompt of PROMPTS) {
    const started = Date.now();
    let out: { message?: { content?: string }; finish_reason?: string } | undefined;
    try {
      const res = await fetch('https://api.deepinfra.com/v1/openai/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: `${LLM_PROMPT}\n\nPrompt: ${prompt}` }],
          temperature: 0,
          max_tokens: maxTokens,
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        console.error(`${model}: HTTP ${res.status}: ${text.slice(0, 200)}`);
        continue;
      }
      const data = JSON.parse(text) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
      };
      out = data.choices?.[0];
    } catch (err) {
      console.error(`${model}: call failed on "${prompt.slice(0, 30)}": ${err}`);
      continue;
    }
    const raw = out?.message?.content ?? '';
    if (out?.finish_reason === 'length') truncations++;
    const flags = parseLlmFlags(raw);
    const nonNull = [
      flags.emotional,
      flags.technical,
      flags.abstract,
      flags.sentiment,
      flags.openEnded,
    ].some((f) => f !== null);
    if (nonNull) {
      parsed++;
      const allSet = Object.values(flags).every((f) => f !== null);
      if (allSet) fullyParsed++;
    }
    latencies.push(Date.now() - started);
  }
  const meanLatencyMs = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);
  return { model, parsed, fullyParsed, truncations, meanLatencyMs };
};

const main = async (): Promise<void> => {
  const results: Result[] = [];
  for (const model of CANDIDATES) {
    process.stdout.write(`running ${model}...`);
    results.push(await run(model));
  }
  console.log(JSON.stringify(results, null, 2));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
