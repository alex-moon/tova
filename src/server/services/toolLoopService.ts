import type Groq from 'groq-sdk';
import { inferenceService } from './inferenceService';
import { webSearch } from './webSearchService';

/*
 * Bounded web-search tool loop for #16: one optional search round, then the
 * final answer. Deeper iteration (and hosting this in a real agentic loop)
 * belongs to #4.
 */

export const WEB_SEARCH_TOOL: Groq.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for up-to-date or external information',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The web search query' } },
      required: ['query'],
    },
  },
};

const SEARCH_RESULT_HEADER = 'Web search results';

const formatResults = (results: { title: string; snippet: string; url: string }[]) =>
  results.map((r) => `[${r.title}](${r.url}): ${r.snippet}`).join('\n');

export interface SearchStageAnswer {
  kind: 'answer';
  content: string;
  sources: string[];
}

export interface SearchStageToolRound {
  kind: 'tool-results';
  messages: Groq.Chat.ChatCompletionMessageParam[];
  sources: string[];
}

export type SearchStageResult = SearchStageAnswer | SearchStageToolRound;

// Runs the first completion with the web_search tool attached. If the model
// requests a search, executes it (never throwing — webSearch degrades to [])
// and returns the augmented message list for the caller's final completion.
// If the model answers directly, returns the answer as-is.
export const runSearchStage = async (
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  model: string,
): Promise<SearchStageResult> => {
  const first = await inferenceService.createCompletion({
    messages,
    model: model,
    tools: [WEB_SEARCH_TOOL],
  });
  const message = first.choices?.[0]?.message;
  const toolCalls = message?.tool_calls ?? [];
  if (toolCalls.length === 0) {
    return {
      kind: 'answer',
      content: message?.content || '',
      sources: [],
    };
  }

  const toolMessages: Groq.Chat.ChatCompletionMessageParam[] = [
    ...messages,
    { role: 'assistant', content: message?.content || '', tool_calls: toolCalls },
  ];
  const sources: string[] = [];
  for (const call of toolCalls) {
    if (call.type === 'function' && call.function.name === 'web_search') {
      let query = '';
      try {
        query = String(JSON.parse(call.function.arguments).query ?? '');
      } catch {
        query = call.function.arguments ?? '';
      }
      const results = await webSearch(query);
      sources.push(...results.map((r) => r.url));
      const body =
        results.length > 0
          ? 'Search results — cite the sources you use inline as markdown links:\n' +
            formatResults(results)
          : 'The search returned no usable results; answer from your own knowledge.';
      toolMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: `${SEARCH_RESULT_HEADER} for "${query}": ${body}`,
      });
    } else {
      toolMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: `Unknown tool: ${call.function.name}`,
      });
    }
  }
  return { kind: 'tool-results', messages: toolMessages, sources };
};
