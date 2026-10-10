"use strict";
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
const express_1 = __importDefault(require("express"));
const auth_1 = require("../middleware/auth");
const evalRunsAdminService_1 = require("../services/evalRunsAdminService");
const evalRunService_1 = require("../services/evalRunService");
const config_1 = require("../config");
const router = express_1.default.Router();
// Same guard as the other admin surfaces: cookie sessions for the browser
// flow, PAT bearer for the agent/CLI path (#184).
const adminGuard = [auth_1.authenticateBearerOrSession, (0, auth_1.requireRole)('admin')];
// Mongo ObjectId hex; validated before any query so a garbage id is a 400/404,
// never a driver error.
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const evalModels = () => (0, evalRunService_1.resolveScheduledModels)({
    models: config_1.config.evals.models,
    model: config_1.config.evals.model,
    provider: config_1.config.evals.provider,
});
// Recent runs, newest first. `limit` is clamped server-side.
router.get('/evals/runs', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const rawLimit = Number(req.query.limit);
    const runs = yield (0, evalRunsAdminService_1.listEvalRuns)(Number.isInteger(rawLimit) ? rawLimit : undefined);
    res.json({ runs });
}));
// One run's per-case breakdown.
router.get('/evals/runs/:id', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const id = String(req.params.id);
    if (!OBJECT_ID_PATTERN.test(id))
        return res.status(400).json({ message: 'Invalid run id' });
    const run = yield (0, evalRunsAdminService_1.getEvalRun)(id);
    if (!run)
        return res.status(404).json({ message: 'Run not found' });
    res.json(run);
}));
/*
 * Manual "Run now" (Decision 7): writes the `running` lease, then runs the
 * suite in the background so the request returns immediately (the suite drives
 * live providers and can take minutes). The busy guard rejects a second run
 * with 409 (Decision 6); a crash is recorded on the rollup, not here.
 */
router.post('/evals/run', ...adminGuard, (_req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const options = { models: evalModels(), trigger: 'manual' };
    try {
        const id = yield (0, evalRunService_1.beginEvalRun)(options);
        // Best-effort LangSmith export (Decision 4): resolve the client lazily so a
        // keyless deploy records the rollup without an export. Never awaited here —
        // the suite runs in the background.
        const langsmithClient = yield (0, evalRunService_1.langsmithClientFromEnv)(config_1.config.langsmith.apiKey);
        void (0, evalRunService_1.executeEvalRun)(id, options, { langsmithClient }).catch(() => {
            // The run settles its own `error` row; nothing to surface post-202.
        });
        return res.status(202).json({ id });
    }
    catch (error) {
        if (error instanceof evalRunService_1.EvalRunBusyError) {
            return res.status(409).json({ message: error.message });
        }
        return res.status(500).json({ message: 'Failed to start eval run' });
    }
}));
exports.default = router;
