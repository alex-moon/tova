import 'dotenv/config';
import express, { type Express } from 'express';
import { type Server } from 'http';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import path from 'path';
import { createProxyMiddleware } from 'http-proxy-middleware';
import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import feedbackRoutes from './routes/feedback';
import adminRoutes from './routes/admin';
import adminPatRoutes from './routes/adminPats';
import adminLangsmithRoutes from './routes/adminLangsmith';
import adminEvalsRoutes from './routes/adminEvals';
import profileRoutes from './routes/profile';
import assetRoutes from './routes/assets';
import taskRoutes from './routes/tasks';
import connectorRoutes from './routes/connectors';
import capabilityRoutes from './routes/capabilities';
import { buildMongoUri } from '@tova/shared';
import { getJwtSecret } from './config/jwt';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { startAssetJobPoller } from './services/assetJobService';
import { startTaskPoller } from './services/taskService';
import { processTaskJob } from './services/taskProcessor';
import { startTraceStatsPoller } from './services/traceStatsCacheService';
import { startAssetVersionPruner } from './services/assetVersionPrune';
import { startPendingAssetSweeper } from './services/assetPresign';
import { processAssetConversionJob } from './services/assetJobProcessor';
import { startEvalScheduler, hasRunForUtcDay } from './services/evalScheduler';
import {
  resolveScheduledModels,
  startEvalRun,
  langsmithClientFromEnv,
} from './services/evalRunService';
import { startMemoryEvalRun } from './services/memoryEvalRunService';
import { config } from './config';
import { attachConsoleCapture } from './services/logService';
import { requestLog } from './middleware/requestLog';
import { redactForLog } from './services/logRedaction';

attachConsoleCapture();

// Process-level safety net: rejections logged, uncaught exceptions exit.
// @see #248 #358
export const isTesseractWorkerError = (err: unknown): boolean => {
  const stack =
    typeof err === 'object' && err !== null && 'stack' in err
      ? String((err as { stack?: unknown }).stack ?? '')
      : '';
  return /node_modules[/\\]tesseract\.js/.test(stack);
};

export const installProcessSafetyNet = (): void => {
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', redactForLog(reason));
  });
  process.on('uncaughtException', (err) => {
    if (isTesseractWorkerError(err)) {
      console.error('Contained tesseract worker error:', redactForLog(err));
      return;
    }
    console.error('Uncaught exception:', redactForLog(err));
    process.exit(1);
  });
};

const DEFAULT_PORT = 5000;

const getPort = () => {
  const parsedPort = Number(process.env.PORT);
  return Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : DEFAULT_PORT;
};

export const connectToDatabase = async (mongoUri = buildMongoUri()) => {
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');
};

export const createApp = (): Express => {
  const app = express();

  // Behind a proxy, trust only the last TRUST_PROXY_HOPS XFF entries.
  // @see #50
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  if (Number.isInteger(hops) && hops > 0) {
    app.set('trust proxy', hops);
  }

  // Strict clientside hardening headers; CSP tuning out of scope.
  // @see #32
  app.use(helmet());

  // Same-origin app in dev (Vite) and prod (static), so no CORS middleware.
  // @see #32
  const isProduction = process.env.NODE_ENV === 'production';

  // JWT configuration should fail at boot in production, not per request.
  if (isProduction) getJwtSecret();

  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isProduction ? 500 : 100000,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: isProduction ? 20 : 100000,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });

  app.use(globalLimiter);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestLog);

  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/messages', feedbackRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/admin', adminPatRoutes);
  app.use('/api/admin', adminLangsmithRoutes);
  app.use('/api/admin', adminEvalsRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/assets', assetRoutes);
  app.use('/api/tasks', taskRoutes);
  app.use('/api/connectors', connectorRoutes);
  app.use('/api/capabilities', capabilityRoutes);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (process.env.NODE_ENV === 'production') {
    const clientBuildPath = path.join(__dirname, '../../client/dist');
    app.use(express.static(clientBuildPath));

    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(clientBuildPath, 'index.html'));
    });
  } else if (process.env.NODE_ENV !== 'test') {
    app.use(
      '/',
      createProxyMiddleware({
        target: 'http://localhost:5173',
        changeOrigin: true,
        ws: true,
      }),
    );
  }

  return app;
};

export const startServer = async (): Promise<Server> => {
  installProcessSafetyNet();
  const app = createApp();
  const port = getPort();

  void connectToDatabase().catch((err) => {
    console.error('MongoDB connection error:', err);
  });

  // In-process conversion worker; no-op under test to isolate route tests.
  // @see #67
  if (process.env.NODE_ENV !== 'test') {
    startAssetJobPoller(processAssetConversionJob);

    // Task sequencer poller, same non-test gate.
    // @see #254 #251
    startTaskPoller(processTaskJob);

    // Daily eval suites, both kinds in one sequential tick, off unless set.
    // @see #225 #289
    startEvalScheduler(
      [
        {
          kind: 'tool-use',
          hasRun: (now) => hasRunForUtcDay(now, 'tool-use'),
          run: async () => {
            // Best-effort LangSmith export, config-resolved.
            // @see #142
            const langsmithClient = await langsmithClientFromEnv(config.langsmith.apiKey);
            return startEvalRun(
              {
                models: resolveScheduledModels({
                  models: config.evals.models,
                  model: config.evals.model,
                  provider: config.evals.provider,
                }),
                trigger: 'scheduled',
              },
              { langsmithClient },
            );
          },
        },
        {
          kind: 'memory',
          hasRun: (now) => hasRunForUtcDay(now, 'memory'),
          // Retrieval stage only: gate/judge stay off the unattended schedule.
          run: () => startMemoryEvalRun({ stages: ['retrieval'], trigger: 'scheduled' }),
        },
      ],
      {
        enabled: config.evals.schedule === 'daily',
        hourUtc: config.evals.hourUtc ? Number(config.evals.hourUtc) : undefined,
      },
    );
    // Keep the admin Traces summary warm so the tab loads from Mongo.
    // @see #224
    startTraceStatsPoller();

    // Daily prune of superseded asset versions (older than a year).
    // @see #369
    startAssetVersionPruner();

    // Hourly reclaim of never-confirmed uploads (rows + Spaces objects).
    // @see #396
    startPendingAssetSweeper();
  }

  return app.listen(port, () => {
    console.log('Server is running on port %d', port);
  });
};
