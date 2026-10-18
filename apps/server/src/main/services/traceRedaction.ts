// Trace payloads are a leak surface; redact at the exporter.
// @see #145

import type { AnyExportedSpan, TracingEvent } from '@mastra/core/observability';
import { LangSmithExporter } from '@mastra/langsmith';

import { redactString } from './logRedaction';

const MAX_DEPTH = 6;
const MAX_STRING = 2000;

// Traces stay readable: long prose keeps head/tail words instead of a
// wholesale blank. @see #383
const TRACE_REDACT = { partial: true } as const;

export const redactDeep = (value: unknown, depth = 0): unknown => {
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (typeof value === 'string') return redactString(value.slice(0, MAX_STRING), TRACE_REDACT);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactDeep(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      const source = value as Record<string, unknown>;
      source[key] = redactDeep(source[key], depth + 1);
    }
    return value;
  }
  return value;
};

export interface RedactableSpan {
  input?: unknown;
  output?: unknown;
  errorInfo?: { message?: string; stack?: string; details?: unknown } | null;
}

// Structural bounds only (depth/size), built fresh — error content stays
// verbatim and cycles cannot survive into the exporter. @see #383
const capDeep = (value: unknown, depth = 0): unknown => {
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => capDeep(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      copy[key] = capDeep((value as Record<string, unknown>)[key], depth + 1);
    }
    return copy;
  }
  return value;
};

// errorInfo passes through unredacted — errors are never softened; details
// keep only the structural bounds redactDeep used to apply. @see #383
export const redactSpanPayload = (span: AnyExportedSpan | RedactableSpan): unknown => {
  const target = span as RedactableSpan;
  if (target.input !== undefined) target.input = redactDeep(target.input);
  if (target.output !== undefined) target.output = redactDeep(target.output);
  if (target.errorInfo?.details) target.errorInfo.details = capDeep(target.errorInfo.details);
  return span;
};

export class RedactedLangSmithExporter extends LangSmithExporter {
  protected override async _preExportTracingEvent(event: TracingEvent): Promise<TracingEvent> {
    const processed = await super._preExportTracingEvent(event);
    redactSpanPayload(processed.exportedSpan);
    return processed;
  }
}
