"use strict";
/**
 * Types for the #112 deterministic eval framework. Graders are code, not
 * LLM-judges: each eval case declares assertions over an observed run
 * (tool-call records, assembled prompt, produced content) and a deterministic
 * aggregator maps assertion results to pass/partial/fail.
 */
Object.defineProperty(exports, "__esModule", { value: true });
