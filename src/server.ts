/* Process entry that listens for the CGS clinic API.
 * Loads env, connects Prisma, and starts the HTTP server. */
import { createApp } from './app.js';
import { env } from './config/env.js';
import { disconnectPrisma } from './config/db.js';
import { startJobWorker } from './workers/job.worker.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`========================================================`);
  console.log(`🚀 CGS Business API running on http://localhost:${env.PORT}`);
  console.log(`⚙️  Environment: ${env.NODE_ENV}`);
  console.log(`========================================================`);

  if (env.WORKER_ENABLED) {
    startJobWorker();
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n[Server] Port ${env.PORT} is already in use.\n` +
        `Another CGS Backend is still running (common after a crashed tsx watch).\n` +
        `Fix: run  npm run free-port  then  npm run dev\n` +
        `Or in PowerShell:\n` +
        `  Get-NetTCPConnection -LocalPort ${env.PORT} | % { Stop-Process -Id $_.OwningProcess -Force }\n`
    );
    process.exit(1);
  }
  throw err;
});

const gracefulShutdown = (signal: string) => {
  console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`);
  server.close(async () => {
    try {
      await disconnectPrisma();
      console.log('[Server] Prisma disconnected.');
    } catch (err) {
      console.error('[Server] Prisma disconnect error:', err);
    }
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });
  // Force-exit if close hangs (hot-reload / stuck sockets)
  setTimeout(() => process.exit(1), 8000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
