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
import mcpServerRoutes from './routes/mcpServers';
import { buildMongoUri } from './mongoUri';
import { getJwtSecret } from './config/jwt';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { startAssetJobPoller } from './services/assetJobService';
import { processAssetConversionJob } from './services/assetJobProcessor';
import { startEvalScheduler } from './services/evalScheduler';
import { resolveScheduledModels, startEvalRun } from './services/evalRunService';
import { config } from './config';
import { attachConsoleCapture } from './services/logService';
import { requestLog } from './middleware/requestLog';

attachConsoleCapture();

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

  // Coarse geolocation (#50) reads req.ip; behind nginx the socket address is
  // the proxy, so trust the last TRUST_PROXY_HOPS entries of X-Forwarded-For.
  // Deploy concern: the outermost proxy must overwrite (not append to)
  // client-supplied X-Forwarded-For or users could spoof their location.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  if (Number.isInteger(hops) && hops > 0) {
    app.set('trust proxy', hops);
  }

  // Strict clientside hardening headers; CSP is intentionally using helmet's
  // defaults (CSP tuning is out of scope for #32).
  app.use(helmet());

  // Same-origin app in both dev (Vite proxy) and prod (static build): no
  // cross-origin API consumer exists, so no CORS middleware (issue #32).
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
  app.use('/api/mcp-servers', mcpServerRoutes);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (process.env.NODE_ENV === 'production') {
    const clientBuildPath = path.join(__dirname, '../../src/client/dist');
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
  const app = createApp();
  const port = getPort();

  void connectToDatabase().catch((err) => {
    console.error('MongoDB connection error:', err);
  });

  // Issue #67: in-process conversion worker; no-op under test so route tests
  // don't inherit background polling.
  if (process.env.NODE_ENV !== 'test') {
    startAssetJobPoller(processAssetConversionJob);

    // #225: daily eval suite. Off unless TOVA_EVAL_SCHEDULE=daily; started in
    // the same non-test block so tests never inherit a live provider job.
    startEvalScheduler(
      () =>
        startEvalRun({
          models: resolveScheduledModels({
            models: config.evals.models,
            model: process.env.TOVA_EVAL_MODEL,
            provider: process.env.TOVA_EVAL_PROVIDER,
          }),
          trigger: 'scheduled',
        }),
      {
        enabled: config.evals.schedule === 'daily',
        hourUtc: config.evals.hourUtc ? Number(config.evals.hourUtc) : undefined,
      },
    );
  }

  return app.listen(port, () => {
    console.log('Server is running on port %d', port);
  });
};
