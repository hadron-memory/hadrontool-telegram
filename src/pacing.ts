/**
 * Per-chat send pacing (spec 042): Telegram allows roughly 1 msg/s per chat
 * and ~20/min per group; the tool paces and absorbs SHORT waits inside the
 * request, but NEVER holds a request long or acks an undelivered message —
 * on saturation the op returns provider_rate_limited + retryAfter, and
 * durable retry belongs to core's sweep worker (which holds the cursor and
 * replays with the same idempotencyKey).
 *
 * State is deliberately in-memory: it is pacing, not a delivery queue —
 * nothing is lost on restart because nothing undelivered was ever acked.
 */
import { config } from './config.js';
import { ProviderRateLimitedError } from './errors.js';

/** Longest a request is held for pacing before we bounce to the caller. */
const MAX_INLINE_WAIT_MS = 5_000;

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Earliest next-send time per `${connectionId}:${chatId}`. */
const nextFreeAt = new Map<string, number>();

/** Periodically drop stale entries so the map can't grow unboundedly. */
const SWEEP_INTERVAL_MS = 60_000;
let lastSweep = 0;
function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, at] of nextFreeAt) {
    if (at <= now) nextFreeAt.delete(key);
  }
}

/**
 * Reserve a send slot for a chat: waits out a short gap inline, or throws
 * provider_rate_limited when the projected wait exceeds the inline budget.
 * The slot is consumed on reservation — two concurrent sends to one chat
 * serialize (or the later one bounces), never both fire at once.
 */
export async function reserveSendSlot(connectionId: string, chatId: string): Promise<void> {
  const gap = config.sendGapMs;
  if (gap <= 0) return; // pacing disabled (tests)
  const key = `${connectionId}:${chatId}`;
  const now = Date.now();
  sweep(now);
  const at = Math.max(now, nextFreeAt.get(key) ?? 0);
  const wait = at - now;
  if (wait > MAX_INLINE_WAIT_MS) {
    throw new ProviderRateLimitedError(Math.ceil(wait / 1000));
  }
  nextFreeAt.set(key, at + gap);
  if (wait > 0) await sleep(wait);
}

/**
 * Record a provider 429 for a chat so subsequent sends back off without
 * hitting Telegram again before `retryAfterSeconds` has passed.
 */
export function recordProviderBackoff(connectionId: string, chatId: string, retryAfterSeconds: number): void {
  const key = `${connectionId}:${chatId}`;
  const until = Date.now() + retryAfterSeconds * 1000;
  nextFreeAt.set(key, Math.max(nextFreeAt.get(key) ?? 0, until));
}
