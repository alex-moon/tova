import { mastraMessagesFor } from '../../main/services/mastraService';
import type { CompletionOptions } from '../../main/services/llmTypes';

/*
 * #115: the neutral message contract widens to OpenAI-style content parts.
 * Mastra consumes AI-SDK-style parts, so the DeepInfra connector maps
 * `image_url` parts onto `image` parts (image: URL) and Groq must reject
 * part arrays outright — completions with images never route there (#94).
 */

const messagesWith = (content: CompletionOptions['messages'][number]['content']) => [
  { role: 'system' as const, content: 'You are Tova.' },
  { role: 'user' as const, content },
];

const stringArray = messagesWith('plain text turn');
const partArray = messagesWith([
  { type: 'text', text: 'what is in this image?' },
  { type: 'image_url', image_url: { url: 'https://spaces.example.com/presigned.png' } },
]);

type MastraMessage = { role: string; content: unknown };

describe('mastraMessagesFor (#115 multimodal mapping)', () => {
  it('passes string-only message lists through untouched for any provider', () => {
    const deepinfra = mastraMessagesFor('deepinfra', stringArray);
    expect(deepinfra).toEqual(stringArray);
  });

  it('maps neutral image_url parts to AI-SDK image parts with a URL object (deepinfra)', () => {
    const [system, user] = mastraMessagesFor('deepinfra', partArray) as MastraMessage[];
    expect(system.content).toBe('You are Tova.');
    const parts = user.content as Array<Record<string, unknown>>;
    expect(parts).toEqual([
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', image: new URL('https://spaces.example.com/presigned.png') },
    ]);
  });

  it('rejects part-array content on the Groq connector with a clear error', () => {
    expect(() => mastraMessagesFor('groq', partArray)).toThrow(
      'The Groq connector does not support multimodal (image) content parts',
    );
  });

  it('still allows text parts (no images) on deepinfra', () => {
    const textOnly = messagesWith([{ type: 'text', text: 'just text' }]);
    const [, user] = mastraMessagesFor('deepinfra', textOnly) as MastraMessage[];
    expect(user.content).toEqual([{ type: 'text', text: 'just text' }]);
  });
});
