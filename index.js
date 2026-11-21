
import 'dotenv/config';
import { createApp } from './app.js';
import { pool } from './db/pool.js';

const app = createApp();

const port = Number(process.env.PORT || 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid port number');
}

const server = app.listen(port, () => {
  console.log(
    `Formula Engine Service running at http://localhost:${port}`
  );
});

server.on('error', (error) => {
  console.error('Server startup error:', error);
  process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(
    `\nReceived ${signal}. Closing HTTP server and MySQL pool...`
  );

  server.close(async (error) => {
    try {
      if (error) {
        console.error('Error closing HTTP server:', error);
      }

      await pool.end();

      console.log('MySQL pool closed cleanly.');

      process.exit(error ? 1 : 0);
    } catch (err) {
      console.error('Error closing MySQL pool:', err);
      process.exit(1);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
