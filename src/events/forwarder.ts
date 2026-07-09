/**
 * Event plane, tool → core (spec 042): normalized Telegram events are POSTed
 * to hadron-server's internal ingress over HTTP now, designed so the
 * transport can wrap behind a NATS subject later without touching callers.
 *
 * DELIVERY CONTRACT (the spec-042 invariant the reviews hardened): the
 * forwarder returns `true` only when the event is durably with core (2xx) or
 * deliberately unconfigured (CORE_EVENTS_URL unset ⇒ logged + dropped BY
 * CHOICE). The poll worker advances the getUpdates cursor — which confirms
 * updates to Telegram, deleting them server-side — only on `true`. A `false`
 * leaves the cursor put, and Telegram's 24h server-side queue is the durable
 * retry buffer.
 */
import { config } from '../config.js';
import { logError, logInfo } from '../logger.js';

/** Normalized message sender. */
export interface EventSender {
  /** Telegram's numeric user id as a decimal string. */
  telegramUserId: string;
  username: string | null;
  displayName: string;
  isBot: boolean;
}

/** A normalized inbound message (DM or group). */
export interface TelegramMessageEvent {
  event: 'telegram.message.received';
  connectionId: string;
  /** Telegram chat id, decimal string. */
  chatId: string;
  /** Forum-topic thread, when the supergroup has Topics enabled. */
  messageThreadId: number | null;
  kind: 'dm' | 'group';
  from: EventSender;
  messageId: number;
  replyToMessageId: number | null;
  text: string;
  /** ISO timestamp derived from Telegram's unix `date`. */
  receivedAt: string;
}

/** A `/start <payload>` DM — the deep-link binding redemption (spec 042). */
export interface TelegramStartEvent {
  event: 'telegram.start';
  connectionId: string;
  chatId: string;
  from: EventSender;
  /** The deep-link payload (may be empty for a bare /start). */
  payload: string;
}

export type TelegramEvent = TelegramMessageEvent | TelegramStartEvent;

/** Signature of the forwarder — injectable for tests. Returns delivery success. */
export type EventForwarder = (event: TelegramEvent) => Promise<boolean>;

/** Production forwarder: POST to core with the events bearer token. */
export const forwardEventToCore: EventForwarder = async (event) => {
  if (!config.coreEventsUrl) {
    // Unconfigured consumer is deliberate (dev, staged rollout) — dropping
    // is correct and the cursor must still advance, so this is a `true`.
    logInfo(`event ${event.event} for connection ${event.connectionId} dropped (CORE_EVENTS_URL unset)`);
    return true;
  }
  try {
    const res = await fetch(config.coreEventsUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.coreEventsToken ? { authorization: `Bearer ${config.coreEventsToken}` } : {}),
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logError(`core event ingress returned ${res.status} for ${event.event} (connection ${event.connectionId})`);
      return false;
    }
    return true;
  } catch (err) {
    logError(`failed to deliver ${event.event} for connection ${event.connectionId} to core`, err);
    return false;
  }
};
