/**
 * Boot: env validation (config.ts import throws on production misconfig),
 * HTTP server, and the getUpdates poll worker.
 */
import { createApp } from './app.js';
import { config, isTest } from './config.js';
import { db } from './db.js';
import { forwardEventToCore } from './events/forwarder.js';
import { startPollWorker } from './jobs/poller.js';
import { logInfo } from './logger.js';
import { telegramProvider } from './providers/botapi/client.js';

const app = createApp(db, telegramProvider, forwardEventToCore);

app.listen(config.port, () => {
  logInfo(`hadrontool-telegram listening on :${config.port}`);
  if (!config.coreEventsUrl) {
    logInfo('CORE_EVENTS_URL not set — inbound Telegram events will be logged and dropped');
  }
});

if (!config.disablePollWorker && !isTest) {
  startPollWorker(db, telegramProvider, forwardEventToCore);
} else {
  logInfo('poll worker disabled');
}
