import { redactForLog } from '../logRedaction';
import { inferenceService } from './inferenceService';
import type { CompletionOptions, NeutralCompletion, StructuredOutputConfig } from './llmTypes';
import { config } from '../../config/index';

export type AuxCompletionParams<T> = Omit<
  CompletionOptions & { structuredOutput: StructuredOutputConfig<T> },
  'provider' | 'model'
>;

// One aux-model call: lazy provider/model read, trace threading, catch to null.
// A structured call always yields `object`; its absence is a contract breach.
// @see #238 #398
export const auxCompletion = async <T>(
  label: string,
  params: AuxCompletionParams<T>,
): Promise<(NeutralCompletion & { object: T }) | null> => {
  try {
    const completion = await inferenceService.createStructuredCompletion<T>({
      ...params,
      provider: config.aux.provider,
      model: config.aux.model,
    });
    if (!completion || completion.object == null) return null;
    return completion;
  } catch (err) {
    console.error('%s error:', label, redactForLog(err));
    return null;
  }
};

// Cap on user content sent to the aux classifier; longer inputs get clipped.
// @see #398
export const AUX_INPUT_CHAR_CAP = 4000;

const QUOTE_STRIP_RE = /^["'“”`]+|["'“”`]+$/g;

/* Strip surrounding straight/curly quotes and backticks from aux output. */
// @see #398
export const stripSurroundingQuotes = (value: string): string => value.replace(QUOTE_STRIP_RE, '');
