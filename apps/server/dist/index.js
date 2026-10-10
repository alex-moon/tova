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
exports.startServer = exports.createApp = exports.connectToDatabase = exports.installProcessSafetyNet = void 0;
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const mongoose_1 = __importDefault(require("mongoose"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const path_1 = __importDefault(require("path"));
const http_proxy_middleware_1 = require("http-proxy-middleware");
const auth_1 = __importDefault(require("./routes/auth"));
const chat_1 = __importDefault(require("./routes/chat"));
const feedback_1 = __importDefault(require("./routes/feedback"));
const admin_1 = __importDefault(require("./routes/admin"));
const adminPats_1 = __importDefault(require("./routes/adminPats"));
const adminLangsmith_1 = __importDefault(require("./routes/adminLangsmith"));
const adminEvals_1 = __importDefault(require("./routes/adminEvals"));
const profile_1 = __importDefault(require("./routes/profile"));
const assets_1 = __importDefault(require("./routes/assets"));
const mcpServers_1 = __importDefault(require("./routes/mcpServers"));
const mongoUri_1 = require("./mongoUri");
const jwt_1 = require("./config/jwt");
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const assetJobService_1 = require("./services/assetJobService");
const traceStatsCacheService_1 = require("./services/traceStatsCacheService");
const assetJobProcessor_1 = require("./services/assetJobProcessor");
const evalScheduler_1 = require("./services/evalScheduler");
const evalRunService_1 = require("./services/evalRunService");
const config_1 = require("./config");
const logService_1 = require("./services/logService");
const requestLog_1 = require("./middleware/requestLog");
const logRedaction_1 = require("./services/logRedaction");
(0, logService_1.attachConsoleCapture)();
/*
 * Process-level safety net (#248). Nothing an outbound fetch or background
 * job does should be able to take the whole server down: before this, a single
 * unhandled rejection (e.g. a stalled `fetch` aborting with a DOMException)
 * hit Node's default and terminated the process, turning every request into a
 * 502 until a redeploy. Rejections are logged and swallowed so the server
 * keeps serving; an uncaught exception is logged and exits, letting Docker's
 * restart policy bring the process back cleanly rather than limp on in an
 * undefined state.
 */
const installProcessSafetyNet = () => {
    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled promise rejection:', (0, logRedaction_1.redactForLog)(reason));
    });
    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception:', (0, logRedaction_1.redactForLog)(err));
        process.exit(1);
    });
};
exports.installProcessSafetyNet = installProcessSafetyNet;
const DEFAULT_PORT = 5000;
const getPort = () => {
    const parsedPort = Number(process.env.PORT);
    return Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : DEFAULT_PORT;
};
const connectToDatabase = (...args_1) => __awaiter(void 0, [...args_1], void 0, function* (mongoUri = (0, mongoUri_1.buildMongoUri)()) {
    yield mongoose_1.default.connect(mongoUri);
    console.log('Connected to MongoDB');
});
exports.connectToDatabase = connectToDatabase;
const createApp = () => {
    var _a;
    const app = (0, express_1.default)();
    // Coarse geolocation (#50) reads req.ip; behind nginx the socket address is
    // the proxy, so trust the last TRUST_PROXY_HOPS entries of X-Forwarded-For.
    // Deploy concern: the outermost proxy must overwrite (not append to)
    // client-supplied X-Forwarded-For or users could spoof their location.
    const hops = Number((_a = process.env.TRUST_PROXY_HOPS) !== null && _a !== void 0 ? _a : 1);
    if (Number.isInteger(hops) && hops > 0) {
        app.set('trust proxy', hops);
    }
    // Strict clientside hardening headers; CSP is intentionally using helmet's
    // defaults (CSP tuning is out of scope for #32).
    app.use((0, helmet_1.default)());
    // Same-origin app in both dev (Vite proxy) and prod (static build): no
    // cross-origin API consumer exists, so no CORS middleware (issue #32).
    const isProduction = process.env.NODE_ENV === 'production';
    // JWT configuration should fail at boot in production, not per request.
    if (isProduction)
        (0, jwt_1.getJwtSecret)();
    const globalLimiter = (0, express_rate_limit_1.default)({
        windowMs: 15 * 60 * 1000,
        limit: isProduction ? 500 : 100000,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
    });
    const authLimiter = (0, express_rate_limit_1.default)({
        windowMs: 15 * 60 * 1000,
        limit: isProduction ? 20 : 100000,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
    });
    app.use(globalLimiter);
    app.use(express_1.default.json({ limit: '1mb' }));
    app.use((0, cookie_parser_1.default)());
    app.use(requestLog_1.requestLog);
    app.use('/api/auth', authLimiter, auth_1.default);
    app.use('/api/chat', chat_1.default);
    app.use('/api/messages', feedback_1.default);
    app.use('/api/admin', admin_1.default);
    app.use('/api/admin', adminPats_1.default);
    app.use('/api/admin', adminLangsmith_1.default);
    app.use('/api/admin', adminEvals_1.default);
    app.use('/api/profile', profile_1.default);
    app.use('/api/assets', assets_1.default);
    app.use('/api/mcp-servers', mcpServers_1.default);
    app.get('/api/health', (_req, res) => {
        res.json({ status: 'ok' });
    });
    if (process.env.NODE_ENV === 'production') {
        const clientBuildPath = path_1.default.join(__dirname, '../../client/dist');
        app.use(express_1.default.static(clientBuildPath));
        app.get(/.*/, (_req, res) => {
            res.sendFile(path_1.default.join(clientBuildPath, 'index.html'));
        });
    }
    else if (process.env.NODE_ENV !== 'test') {
        app.use('/', (0, http_proxy_middleware_1.createProxyMiddleware)({
            target: 'http://localhost:5173',
            changeOrigin: true,
            ws: true,
        }));
    }
    return app;
};
exports.createApp = createApp;
const startServer = () => __awaiter(void 0, void 0, void 0, function* () {
    (0, exports.installProcessSafetyNet)();
    const app = (0, exports.createApp)();
    const port = getPort();
    void (0, exports.connectToDatabase)().catch((err) => {
        console.error('MongoDB connection error:', err);
    });
    // Issue #67: in-process conversion worker; no-op under test so route tests
    // don't inherit background polling.
    if (process.env.NODE_ENV !== 'test') {
        (0, assetJobService_1.startAssetJobPoller)(assetJobProcessor_1.processAssetConversionJob);
        // #225: daily eval suite. Off unless TOVA_EVAL_SCHEDULE=daily; started in
        // the same non-test block so tests never inherit a live provider job.
        (0, evalScheduler_1.startEvalScheduler)(() => __awaiter(void 0, void 0, void 0, function* () {
            // Best-effort LangSmith export (Decision 4), resolved from config so
            // the service never reaches for env ad hoc (#142).
            const langsmithClient = yield (0, evalRunService_1.langsmithClientFromEnv)(config_1.config.langsmith.apiKey);
            return (0, evalRunService_1.startEvalRun)({
                models: (0, evalRunService_1.resolveScheduledModels)({
                    models: config_1.config.evals.models,
                    model: config_1.config.evals.model,
                    provider: config_1.config.evals.provider,
                }),
                trigger: 'scheduled',
            }, { langsmithClient });
        }), {
            enabled: config_1.config.evals.schedule === 'daily',
            hourUtc: config_1.config.evals.hourUtc ? Number(config_1.config.evals.hourUtc) : undefined,
        });
        // #224: keep the admin Traces summary warm so the tab loads from Mongo.
        (0, traceStatsCacheService_1.startTraceStatsPoller)();
    }
    return app.listen(port, () => {
        console.log('Server is running on port %d', port);
    });
});
exports.startServer = startServer;
