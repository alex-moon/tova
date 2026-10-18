import 'dotenv/config';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

/* One-off #368 probe: structuredOutput support per aux-candidate model. */
// @see #368

const flagsSchema = z.object({
  emotional: z.boolean(),
  technical: z.boolean(),
  sentiment: z.enum(['positive', 'negative', 'neutral']),
});

const listSchema = z.object({
  suggestions: z.array(z.string()),
});

const MODELS = [
  'groq/openai/gpt-oss-20b',
  'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash',
  'fireworks-ai/accounts/fireworks/models/glm-5p3-flash',
];

const probe = async (model: string) => {
  for (const [name, schema, prompt] of [
    [
      'flags',
      flagsSchema,
      'Classify this prompt: "fix my login bug please". Reply with the flags.',
    ],
    ['list', listSchema, 'Generate two short follow-up questions for a chat about DNS.'],
  ] as const) {
    try {
      const agent = new Agent({ id: `probe-${model}`, name: 'probe', model, instructions: '' });
      const started = Date.now();
      const response = await agent.generate(prompt, {
        structuredOutput: {
          schema,
          jsonPromptInjection: 'auto',
          errorStrategy: 'fallback',
          fallbackValue:
            name === 'flags'
              ? { emotional: false, technical: false, sentiment: 'neutral' }
              : { suggestions: [] },
        },
      });
      const ms = Date.now() - started;
      console.log(
        `${model} [${name}]: object=${JSON.stringify(response.object)} usedFallback=${response.usedFallbackValue} (${ms}ms)`,
      );
    } catch (err) {
      console.log(`${model} [${name}]: ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  }
};

(async () => {
  for (const model of MODELS) {
    await probe(model);
  }
})();
