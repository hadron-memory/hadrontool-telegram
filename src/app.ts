/**
 * Express app factory. Dependencies (db, Telegram provider, event forwarder)
 * are injected so tests run the real HTTP surface over fakes.
 *
 * Route map:
 *   GET  /healthz             liveness (public-safe, no secrets)
 *   GET  /readyz              readiness (DB reachable)
 *   GET  /info                capabilities (bearer-gated)
 *   POST /ops/<operation>     operations plane   (bearer-gated, internal)
 *   *    /connections…        connection plane   (bearer-gated, internal)
 *
 * No public route at all — spec 042 decision 4: v1 polls getUpdates, so
 * unlike hadrontool-ms-exchange there is no webhook ingress to expose.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { logError } from './logger.js';
import type { Db } from './db.js';
import type { EventForwarder } from './events/forwarder.js';
import { requireToolToken } from './middleware/auth.js';
import { OPERATIONS } from './ops/index.js';
import type { TelegramProvider } from './providers/botapi/types.js';
import { connectionsRouter } from './routes/connections.js';
import { opsRouter } from './routes/ops.js';

/** Package version, surfaced on /info. */
const VERSION = process.env.npm_package_version ?? '0.1.0';

/** Build the app over injected dependencies. */
export function createApp(db: Db, provider: TelegramProvider, _forward: EventForwarder): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: config.maxBodySize }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/readyz', async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });

  app.get('/info', requireToolToken, (_req, res) => {
    res.json({
      name: 'hadrontool-telegram',
      version: VERSION,
      provider: 'telegram',
      operations: Object.keys(OPERATIONS),
      events: ['telegram.message.received', 'telegram.start'],
    });
  });

  app.use('/ops', requireToolToken, opsRouter(db, provider));
  app.use('/connections', requireToolToken, connectionsRouter(db, provider));

  // Errors thrown OUTSIDE route try/catch blocks — body-parse failures
  // included — get the service's uniform JSON error shape, never Express's
  // default HTML page.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const isParseError = err instanceof SyntaxError || (err as { type?: string } | null)?.type === 'entity.parse.failed';
    if (isParseError) {
      res.status(400).json({ error: 'validation_error', message: 'request body is not valid JSON', field: 'body' });
      return;
    }
    logError('unhandled route error', err);
    res.status(500).json({ error: 'internal_error', message: 'internal error' });
  });

  return app;
}
