"use strict";
/*
 * Provider-neutral LLM result types shared by every `inferenceService`
 * consumer. Deliberately narrow: only the fields actually read by callers
 * are modelled, so provider-specific shapes (Groq/DeepInfra) cannot leak
 * into call sites. Normalisation from provider shapes happens inside the
 * central service only.
 */
Object.defineProperty(exports, "__esModule", { value: true });
