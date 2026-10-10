"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveScheduledModels = exports.startEvalRun = exports.executeEvalRun = exports.beginEvalRun = exports.EvalRunBusyError = exports.langsmithClientFromEnv = exports.runEvalSuite = exports.parseModelsFlag = exports.pushToLangSmith = exports.resolveAssertions = exports.connectorsByProvider = void 0;
/*
 * #225 eval run service: the grading core extracted from
 * `scripts/run-evals.ts` so the CLI and the scheduled "Evals" path share one
 * code path (same stance as `runModelComparison` for #129). The service owns
 * no Mongo connection lifecycle — in-process it uses the shared connection the
 * server already owns; `scripts/run-evals.ts` keeps connect/disconnect.
 *
 * `runEvalSuite` does the work (seed fixtures, drive `runCase`/`gradeRun` over
 * CASES × models, best-effort LangSmith export) and returns per-case results.
 * `startEvalRun` wraps it with the persisted rollup (`EvalRunRecord`) and the
 * single-run lease (Decision 6). Dependencies are injectable so unit tests can
 * exercise the flows without live providers or LangSmith.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const graders_1 = require("../evals/graders");
const cases_1 = require("../evals/cases");
const mongoSource_1 = require("../evals/mongoSource");
const runCase_1 = require("../evals/runCase");
const mastraService_1 = require("./mastraService");
const modelConfigService_1 = require("./modelConfigService");
const rosterConfig_1 = require("./rosterConfig");
const EvalRunRecord_1 = require("../models/EvalRunRecord");
exports.connectorsByProvider = {
    groq: mastraService_1.groqConnector,
    deepinfra: mastraService_1.deepinfraConnector,
    fireworks: mastraService_1.fireworksConnector,
};
const SCORES = { pass: 1, partial: 0.5, fail: 0, error: 0 };
const DATASET_NAME = 'tova-evals';
/**
 * `@repo:<path>` markers resolve against the repository at grading time, so
 * the golden content expectation moves with the file (README) instead of
 * being duplicated inside the case data.
 */
const resolveAssertions = (testCase, readRepoFile) => testCase.assertions.map((assertion) => assertion.type === 'content_equals'
    ? Object.assign(Object.assign({}, assertion), { expected: (0, cases_1.resolveExpectedContent)(assertion.expected, readRepoFile) }) : assertion);
exports.resolveAssertions = resolveAssertions;
/* Best-effort LangSmith export: the `tova-evals` dataset is created when
 * absent and re-used otherwise (score-over-time stays on one dataset), each
 * case becomes an example, each graded run becomes a run on that example
 * with a 1 (pass) / 0.5 (partial) / 0 (fail) feedback score and the
 * assertion report as the comment. Failures degrade to a warning — the
 * local grading result is unchanged. */
const pushToLangSmith = (client, results) => __awaiter(void 0, void 0, void 0, function* () {
    const ls = client;
    if (!(yield ls.hasDataset({ datasetName: DATASET_NAME })))
        yield ls.createDataset(DATASET_NAME);
    // Examples address the dataset by name; re-runs append the fresh results.
    // The returned example id becomes each run's reference example.
    const examples = {};
    for (const result of results) {
        const example = (yield ls.createExample({ prompt: result.testCase.prompt, model: `${result.provider}:${result.model}` }, { score: result.score }, { datasetName: DATASET_NAME }));
        if (example === null || example === void 0 ? void 0 : example.id)
            examples[`${result.provider}:${result.model}/${result.testCase.id}`] = example.id;
    }
    // RunTree is the supported run-submission path in langsmith@0.8 (createRun
    // queues server-side and returns nothing); posting with a
    // reference_example_id is what links each graded run to its dataset row.
    // `model`/`provider` ride in the run metadata so per-model scores
    // accumulate across sweeps (#158's growing evidence base).
    const { RunTree } = yield Promise.resolve().then(() => __importStar(require('langsmith')));
    const end = new Date();
    for (const result of results) {
        const exampleKey = `${result.provider}:${result.model}/${result.testCase.id}`;
        const tree = new RunTree({
            name: result.testCase.id,
            run_type: 'chain',
            inputs: { prompt: result.testCase.prompt },
            outputs: { score: result.score },
            reference_example_id: examples[exampleKey],
            metadata: { model: result.model, provider: result.provider },
            start_time: end.getTime() - 60000,
            end_time: end.getTime(),
            client,
        });
        yield tree.postRun();
        yield tree.end({ outputs: { score: result.score } });
        yield tree.patchRun();
        yield client.createFeedback(tree.id, 'golden-set-assertions', {
            score: SCORES[result.score],
            comment: `${result.provider}:${result.model}\n${result.report.slice(0, 4000)}`,
        });
    }
});
exports.pushToLangSmith = pushToLangSmith;
/**
 * `--models` csv parsing: entries are `<provider>:<model>` or bare `<model>`
 * (bare = deepinfra — completions are pinned there, #94). Returns null when
 * the flag is absent (single-model mode). Throws on a bad value; the CLI maps
 * that to a non-zero exit and prints the message.
 */
const parseModelsFlag = (value, warned) => {
    if (value === undefined)
        return null;
    if (value === 'all') {
        // Wired roster providers only: typesafe/groq are excluded from the roster
        // sweep (no roster rows, no sweep connector) and that exclusion is stated,
        // not hidden (#158 plan).
        warned === null || warned === void 0 ? void 0 : warned('sweep universe: the fixed roster on wired providers (deepinfra, fireworks); ' +
            'other providers are excluded.');
        return (0, modelConfigService_1.sweepModels)(Object.keys(exports.connectorsByProvider)).map(({ provider, model }) => ({ provider, model }));
    }
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
        const sep = entry.indexOf(':');
        if (sep === -1)
            return { provider: 'deepinfra', model: entry };
        if (!(entry.slice(0, sep) in exports.connectorsByProvider)) {
            throw new Error(`Unknown provider in --models '${entry}' (wired: deepinfra, fireworks, groq).`);
        }
        return { provider: entry.slice(0, sep), model: entry.slice(sep + 1) };
    });
};
exports.parseModelsFlag = parseModelsFlag;
const resolveAssertionResults = (assertions) => assertions.map((r) => `${JSON.stringify(r.assertion.type)}=${r.passed ? 'y' : 'n'}`).join(' ');
/**
 * Runs the golden suite over every requested model and returns per-case
 * results. Seeds fixtures, clears them on teardown unless `keepFixtures`, and
 * exports to LangSmith when a client is available (best-effort: an export
 * failure never fails the run).
 */
const runEvalSuite = (options_1, ...args_1) => __awaiter(void 0, [options_1, ...args_1], void 0, function* (options, deps = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const seedSource = (_a = deps.seedSource) !== null && _a !== void 0 ? _a : mongoSource_1.seedEvalSource;
    const clearSource = (_b = deps.clearSource) !== null && _b !== void 0 ? _b : mongoSource_1.clearEvalSource;
    const runCaseFn = (_c = deps.runCaseFn) !== null && _c !== void 0 ? _c : runCase_1.runCase;
    const gradeRunFn = (_d = deps.gradeRunFn) !== null && _d !== void 0 ? _d : graders_1.gradeRun;
    const connectors = (_e = deps.connectors) !== null && _e !== void 0 ? _e : exports.connectorsByProvider;
    const readRepoFile = (_f = deps.readRepoFile) !== null && _f !== void 0 ? _f : defaultReadRepoFile;
    const results = [];
    const sweep = options.models.length > 1;
    yield seedSource();
    try {
        for (const { provider, model } of options.models) {
            const connector = connectors[provider];
            for (const testCase of cases_1.CASES) {
                const assertions = (0, exports.resolveAssertions)(testCase, readRepoFile);
                try {
                    const { run, evidence } = yield runCaseFn(connector.createStreamingCompletion, {
                        provider,
                        model,
                        messages: [{ role: 'user', content: testCase.prompt }],
                        userId: mongoSource_1.evalUserId.toHexString(),
                        trace: { sessionId: `tova-evals-${testCase.id}` },
                    }, testCase);
                    const { score, assertions: assertionResults } = gradeRunFn(run, assertions);
                    const report = resolveAssertionResults(assertionResults);
                    results.push({ testCase, model, provider, score, report: `${report}\n${evidence}` });
                    (_g = deps.onCase) === null || _g === void 0 ? void 0 : _g.call(deps, { provider, model, caseId: testCase.id, score, report, evidence });
                }
                catch (error) {
                    const report = `ungraded: ${error instanceof Error ? error.message : String(error)}`;
                    const score = sweep ? 'error' : 'fail';
                    results.push({ testCase, model, provider, score, report });
                    (_h = deps.onCase) === null || _h === void 0 ? void 0 : _h.call(deps, { provider, model, caseId: testCase.id, score, report });
                }
            }
        }
    }
    finally {
        if (!options.keepFixtures)
            yield clearSource();
    }
    if (deps.langsmithClient) {
        try {
            yield (0, exports.pushToLangSmith)(deps.langsmithClient, results);
        }
        catch (error) {
            // Best-effort export: the local grading result is the source of truth.
            (_j = deps.onLangsmithError) === null || _j === void 0 ? void 0 : _j.call(deps, error);
        }
    }
    return results;
});
exports.runEvalSuite = runEvalSuite;
/**
 * Creates a `langsmith` client when a key is configured, else null. Kept out
 * of `runEvalSuite` so the service never reaches for env ad hoc (issue #142's
 * spirit) and tests inject a mock.
 */
const langsmithClientFromEnv = (apiKey) => __awaiter(void 0, void 0, void 0, function* () {
    if (!apiKey)
        return null;
    const { Client } = yield Promise.resolve().then(() => __importStar(require('langsmith')));
    return new Client({ apiKey });
});
exports.langsmithClientFromEnv = langsmithClientFromEnv;
const defaultReadRepoFile = (p) => {
    const repoRoot = node_path_1.default.resolve(__dirname, '../../..');
    return node_fs_1.default.readFileSync(node_path_1.default.join(repoRoot, p), 'utf8');
};
class EvalRunBusyError extends Error {
    constructor() {
        super('An eval run is already in progress.');
        this.name = 'EvalRunBusyError';
    }
}
exports.EvalRunBusyError = EvalRunBusyError;
const MAX_STORED_ERROR_CHARS = 500;
/** Resolves the injectable seams, defaulting to the real collection. */
const resolveRunDeps = (deps) => {
    var _a, _b, _c;
    return ({
        createRecord: (_a = deps.createRecord) !== null && _a !== void 0 ? _a : EvalRunRecord_1.EvalRunRecord.create.bind(EvalRunRecord_1.EvalRunRecord),
        findRunning: (_b = deps.findRunning) !== null && _b !== void 0 ? _b : (() => EvalRunRecord_1.EvalRunRecord.findOne({ status: 'running' }).lean().exec()),
        updateRecord: (_c = deps.updateRecord) !== null && _c !== void 0 ? _c : ((id, update) => EvalRunRecord_1.EvalRunRecord.updateOne({ _id: id }, update).exec()),
    });
};
/**
 * Writes the `running` lease and returns its id. Rejects with
 * `EvalRunBusyError` when a run is already live — the cross-restart
 * serialisation guard (Decision 6). Kept separate from `executeEvalRun` so a
 * "Run now" route can answer 202 immediately after the lease exists.
 */
const beginEvalRun = (options_1, ...args_1) => __awaiter(void 0, [options_1, ...args_1], void 0, function* (options, deps = {}) {
    const { createRecord, findRunning } = resolveRunDeps(deps);
    if (yield findRunning())
        throw new EvalRunBusyError();
    const modelKeys = options.models.map(({ provider, model }) => `${provider}:${model}`);
    const record = yield createRecord({
        startedAt: new Date(),
        status: 'running',
        models: modelKeys,
    });
    return String(record._id);
});
exports.beginEvalRun = beginEvalRun;
/**
 * Runs the suite for an existing lease and settles the document to
 * `done`/`error`. A run-level crash is recorded, never thrown (Decision 5).
 */
const executeEvalRun = (id_1, options_1, ...args_1) => __awaiter(void 0, [id_1, options_1, ...args_1], void 0, function* (id, options, deps = {}) {
    const { updateRecord } = resolveRunDeps(deps);
    try {
        const results = yield (0, exports.runEvalSuite)({ models: options.models }, deps);
        yield updateRecord(id, {
            $set: {
                status: 'done',
                finishedAt: new Date(),
                results: results.map(({ testCase, model, provider, score, report }) => ({
                    caseId: testCase.id,
                    model,
                    provider,
                    score,
                    report,
                })),
            },
        });
        return results;
    }
    catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_STORED_ERROR_CHARS);
        yield updateRecord(id, { $set: { status: 'error', finishedAt: new Date(), error: message } });
        return [];
    }
});
exports.executeEvalRun = executeEvalRun;
/**
 * Persists and executes one suite run. Creates the `running` lease document
 * first (so a crash leaves a reclaimable row), runs the suite, and settles the
 * document to `done`/`error`. Consult `status: 'running'` in Mongo for
 * cross-restart safety (Decision 6): a second caller while one is live is
 * rejected with `EvalRunBusyError`.
 */
const startEvalRun = (options_1, ...args_1) => __awaiter(void 0, [options_1, ...args_1], void 0, function* (options, deps = {}) {
    const id = yield (0, exports.beginEvalRun)(options, deps);
    const results = yield (0, exports.executeEvalRun)(id, options, deps);
    return { id, results };
});
exports.startEvalRun = startEvalRun;
/*
 * #236: the scheduled default is a roster model, not the retired guard model
 * (`openai/gpt-oss-20b` has no roster home). GLM 5.3 Flash is the cheapest
 * roster entry, keeping an unattended daily run as cheap as the roster allows.
 * Sourced from `ROSTER_SEED` so the id cannot drift from the roster definition;
 * override with `TOVA_EVAL_MODELS` (or `TOVA_EVAL_MODEL`/`TOVA_EVAL_PROVIDER`).
 */
const defaultEvalRef = () => {
    var _a, _b;
    const model = (_a = rosterConfig_1.ROSTER_SEED.find((m) => m.modelId === 'zai-org/GLM-5.3-Flash')) !== null && _a !== void 0 ? _a : rosterConfig_1.ROSTER_SEED[0];
    const provider = (_b = model.providers.find((p) => p.provider === 'deepinfra')) !== null && _b !== void 0 ? _b : model.providers[0];
    return { provider: provider.provider, model: provider.modelId };
};
/**
 * Resolves the model set for a scheduled run (OQ2 fallback): the
 * `TOVA_EVAL_MODELS` csv when set, else the runner's single-model default
 * (`TOVA_EVAL_MODEL` / `TOVA_EVAL_PROVIDER`, defaulting to the cheapest roster
 * model on DeepInfra). Values come from config, not ad-hoc `process.env`
 * (issue #142).
 */
const resolveScheduledModels = (evals = {}) => {
    var _a;
    if (evals.models) {
        const parsed = (0, exports.parseModelsFlag)(evals.models);
        if (parsed && parsed.length > 0)
            return parsed;
    }
    const fallback = defaultEvalRef();
    return [
        {
            provider: evals.provider === 'groq' ? 'groq' : fallback.provider,
            model: (_a = evals.model) !== null && _a !== void 0 ? _a : fallback.model,
        },
    ];
};
exports.resolveScheduledModels = resolveScheduledModels;
