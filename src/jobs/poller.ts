/**
 * The getUpdates poll worker — one long-poll loop per active connection.
 *
 * DELIVERY SEMANTICS (spec 042, hardened by the PR #591 reviews): calling
 * getUpdates with offset N confirms every update below N to Telegram, which
 * deletes them server-side — the tool is the LAST STOP. So the cursor
 * (Connection.lastUpdateId) advances only after the update's event is
 * durably with core (forwarder returned true) or needed no delivery (skips).
 * A failed forward leaves the cursor put and the batch is re-fetched next
 * cycle — Telegram's 24h server-side queue is the durable retry buffer.
 * Bounded retries per head-of-line update (DEAD_LETTER_AFTER) keep one
 * poison event from wedging the whole stream: after N failed cycles it is
 * logged loudly and skipped.
 *
 * The worker is Hadron-blind like everything here: it normalizes updates and
 * hands them to the forwarder; core owns bindings, users, and chat nodes.
 */
import { config } from '../config.js';
import { withConnection } from '../connectionCall.js';
import type { Db } from '../db.js';
import { ConnectionNotFoundError, ConnectionUnauthorizedError } from '../errors.js';
import type { EventForwarder, EventSender, TelegramEvent } from '../events/forwarder.js';
import { logError, logInfo } from '../logger.js';
import type { TelegramProvider, TgMessage, TgUpdate } from '../providers/botapi/types.js';

/** Failed forward attempts for a head-of-line update before it is dead-lettered. */
const DEAD_LETTER_AFTER = 5;

/** Pause between drain cycles after an error (provider or forwarder). */
const ERROR_BACKOFF_MS = 5_000;

/** How often the reconciler diffs running loops against the connections table. */
const RECONCILE_INTERVAL_MS = 15_000;

/** Head-of-line failure tracking, per connection. */
const failures = new Map<string, { updateId: number; count: number }>();

/** Reset module state (tests). */
export function clearPollerState(): void {
  failures.clear();
}

/** Build the normalized sender. */
function sender(from: NonNullable<TgMessage['from']>): EventSender {
  return {
    telegramUserId: String(from.id),
    username: from.username ?? null,
    displayName: [from.first_name, from.last_name].filter(Boolean).join(' '),
    isBot: from.is_bot,
  };
}

/**
 * Normalize one update to its event, or null when it needs no delivery:
 * non-message updates, channel posts (v1), and bot-authored messages (which
 * the Bot API mostly withholds anyway — belt and suspenders for loop safety).
 */
export function eventForUpdate(connectionId: string, update: TgUpdate): TelegramEvent | null {
  const msg = update.message;
  if (!msg || !msg.from) return null;
  if (msg.from.is_bot) return null;
  if (msg.chat.type === 'channel') return null;

  const text = msg.text ?? '';
  if (msg.chat.type === 'private' && /^\/start(\s|$)/.test(text)) {
    return {
      event: 'telegram.start',
      connectionId,
      chatId: String(msg.chat.id),
      from: sender(msg.from),
      payload: text.split(/\s+/)[1] ?? '',
    };
  }
  return {
    event: 'telegram.message.received',
    connectionId,
    chatId: String(msg.chat.id),
    messageThreadId: msg.message_thread_id ?? null,
    kind: msg.chat.type === 'private' ? 'dm' : 'group',
    from: sender(msg.from),
    messageId: msg.message_id,
    replyToMessageId: msg.reply_to_message?.message_id ?? null,
    text,
    receivedAt: new Date(msg.date * 1000).toISOString(),
  };
}

/**
 * One drain cycle for one connection: fetch a batch from the current cursor
 * and process it in order. Returns 'stopped' when the loop should end (the
 * connection is gone, disabled, or its token died), 'error' for a transient
 * failure (back off, retry), 'ok' otherwise.
 */
export async function drainOnce(
  db: Db,
  provider: TelegramProvider,
  forward: EventForwarder,
  connectionId: string,
): Promise<'ok' | 'error' | 'stopped'> {
  const connection = await db.connection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.deletedAt || connection.status !== 'ACTIVE' || !connection.pollingEnabled) {
    return 'stopped';
  }

  let updates: TgUpdate[];
  try {
    updates = await withConnection(db, connectionId, undefined, (token) =>
      provider.getUpdates(token, Number(connection.lastUpdateId) + 1, config.pollTimeoutS),
    );
  } catch (err) {
    if (err instanceof ConnectionNotFoundError || err instanceof ConnectionUnauthorizedError) {
      // withConnection already marked the dead token; a 409 (competing
      // poller / webhook set) maps to provider_unavailable → 'error'.
      logError(`poll loop for connection ${connectionId} stopping: ${(err as Error).message}`);
      return 'stopped';
    }
    logError(`getUpdates failed for connection ${connectionId} (will retry)`, err);
    return 'error';
  }

  for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
    const event = eventForUpdate(connectionId, update);
    let handled = true;
    if (event) handled = await forward(event);

    if (!handled) {
      const f = failures.get(connectionId);
      const count = f?.updateId === update.update_id ? f.count + 1 : 1;
      failures.set(connectionId, { updateId: update.update_id, count });
      if (count < DEAD_LETTER_AFTER) {
        // Leave the cursor put — this batch re-fetches next cycle.
        return 'error';
      }
      logError(
        `DEAD-LETTER: dropping update ${update.update_id} for connection ${connectionId} after ${count} failed deliveries: ${JSON.stringify(event)}`,
      );
    }
    failures.delete(connectionId);
    // Advancing the cursor is what confirms the update to Telegram — only
    // after durable handling (or a deliberate skip / dead-letter).
    await db.connection.update({
      where: { id: connectionId },
      data: { lastUpdateId: BigInt(update.update_id) },
    });
  }
  return 'ok';
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the worker: a reconciler tick keeps one drain loop per active
 * connection (new connections picked up within RECONCILE_INTERVAL_MS;
 * deleted/disabled ones stop themselves on their next cycle).
 */
export function startPollWorker(
  db: Db,
  provider: TelegramProvider,
  forward: EventForwarder,
): { stop: () => void } {
  const running = new Set<string>();
  let stopped = false;

  async function loop(connectionId: string): Promise<void> {
    while (!stopped) {
      let outcome: 'ok' | 'error' | 'stopped';
      try {
        outcome = await drainOnce(db, provider, forward, connectionId);
      } catch (err) {
        logError(`drain cycle crashed for connection ${connectionId}`, err);
        outcome = 'error';
      }
      if (outcome === 'stopped') break;
      // 'ok' cycles back immediately — getUpdates itself long-polls.
      if (outcome === 'error') await sleep(ERROR_BACKOFF_MS);
    }
    running.delete(connectionId);
  }

  async function reconcile(): Promise<void> {
    const connections = await db.connection.findMany({
      where: { deletedAt: null, status: 'ACTIVE', pollingEnabled: true },
      select: { id: true },
    });
    for (const { id } of connections) {
      if (!running.has(id)) {
        running.add(id);
        void loop(id);
      }
    }
  }

  const timer = setInterval(() => {
    void reconcile().catch((err) => logError('poll reconciler failed', err));
  }, RECONCILE_INTERVAL_MS);
  void reconcile().catch((err) => logError('poll reconciler failed', err));
  logInfo('poll worker started');

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
