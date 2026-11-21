
import 'dotenv/config';
import express from 'express';
import formulaRoutes from './routes/formulaRoutes.js';
import { pool } from './db/pool.js';

export function createApp() {
  const app = express();

  // Parse incoming JSON requests
  app.use(express.json({ limit: '5mb' }));

  // Health check
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');

      return res.status(200).json({
        status: 'ok',
        database: 'connected'
      });
    } catch {
      return res.status(503).json({
        status: 'degraded',
        database: 'unavailable'
      });
    }
  });

  // Formula API routes
  app.use('/formulas', formulaRoutes);

  // Handle invalid JSON
  app.use((err, _req, res, next) => {
    if (
      err instanceof SyntaxError &&
      err.status === 400 &&
      'body' in err
    ) {
      return res.status(400).json({
        error: {
          code: 'INVALID_JSON',
          message: 'Request body contains invalid JSON',
          details: null
        }
      });
    }

    next(err);
  });

  // Handle unknown routes
  app.use((req, _res, next) => {
    const error = new Error(
      `Route not found: ${req.method} ${req.originalUrl}`
    );

    error.statusCode = 404;
    error.code = 'NOT_FOUND';

    next(error);
  });

  // Centralized error handler
  app.use((err, _req, res, _next) => {
    const statusCode = err.statusCode || 500;

    res.status(statusCode).json({
      error: {
        code: err.code || 'INTERNAL_SERVER_ERROR',
        message: err.message || 'An unexpected error occurred',
        details: err.details ?? null
      }
    });
  });

  return app;
}

export default createApp;
