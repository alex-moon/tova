import { startServer } from './index';

void startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
