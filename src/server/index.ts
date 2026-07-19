import express, { type Express } from 'express';
import { type Server } from 'http';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import path from 'path';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';

dotenv.config();

const DEFAULT_PORT = 5000;
const DEFAULT_MONGODB_URI = 'mongodb://localhost:27017/tova';

const getPort = () => {
  const parsedPort = Number(process.env.PORT);
  return Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : DEFAULT_PORT;
};

export const connectToDatabase = async (mongoUri = process.env.MONGODB_URI || DEFAULT_MONGODB_URI) => {
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');
};

export const createApp = (): Express => {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());

  app.use('/api/auth', authRoutes);
  app.use('/api/chat', chatRoutes);

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
    try {
      const { createProxyMiddleware } = require('http-proxy-middleware');
      app.use(
        '/',
        createProxyMiddleware({
          target: 'http://localhost:5173',
          changeOrigin: true,
          ws: true,
        })
      );
    } catch (_err) {
      console.warn('http-proxy-middleware not found, dev proxy disabled');
    }
  }

  return app;
};

export const startServer = async (): Promise<Server> => {
  const app = createApp();
  const port = getPort();

  void connectToDatabase().catch((err) => {
    console.error('MongoDB connection error:', err);
  });

  return app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
};
