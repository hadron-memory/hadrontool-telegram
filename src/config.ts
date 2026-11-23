/**
 * Environment configuration, validated once at import time.
 *
 * Posture (mirrors hadrontool-ms-exchange): fail LOUD at boot in production
 * for anything the service cannot safely run without; degrade gracefully in
 * development. There are no provider app credentials here — Telegram's
 * credential is the per-connection bot token, which arrives via
 * POST /connections and lives encrypted in this tool's own database.
 */
import 'dotenv/config';

/** True when NODE_ENV is production. */
export const isProduction = process.env.NODE_ENV === 'production';

/** True under vitest (NODE_ENV=test pinned by vitest.config.ts). */
export const isTest = process.env.NODE_ENV === 'test';

/** Read an env var, trimmed; empty string counts as unset. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v === '' ? undefined : v;
}

/** Read a required-in-production env var; throws at boot when missing there. */
function required(name: string): string | undefined {
  const v = env(name);
  if (!v && isProduction) {
    throw new Error(`${name} is required in production — refusing to start`);
  }
  return v;
}

export const config = {
  port: Number(env('PORT') ?? 8080),

  /** Bearer token gating /ops/* and /connections*. Required in production. */
  toolToken: required('TELEGRAM_TOOL_TOKEN'),

  /** 32-byte hex key for AES-256-GCM bot-token encryption at rest. */
  tokenEncryptionKey: required('TOKEN_ENCRYPTION_KEY'),

  /** hadron-server's internal event ingress; unset ⇒ events logged + dropped. */
  coreEventsUrl: env('CORE_EVENTS_URL'),
  coreEventsToken: env('CORE_EVENTS_TOKEN'),

  /** Bot API origin — overridable for tests / self-hosted Bot API servers. */
  telegramApiBase: (env('TELEGRAM_API_BASE') ?? 'https://api.telegram.org').replace(/\/+$/, ''),

  /** getUpdates long-poll timeout (seconds). */
  pollTimeoutS: Number(env('TELEGRAM_POLL_TIMEOUT_S') ?? 30),

  /** Poll worker kill switch (ops plane still serves). */
  disablePollWorker: env('DISABLE_POLL_WORKER') === 'true',

  /** Minimum gap between sends to the same chat (ms). */
  sendGapMs: Number(env('TELEGRAM_SEND_GAP_MS') ?? 1000),

  maxBodySize: env('MAX_BODY_SIZE') ?? '1mb',
} as const;

// Key-shape check runs at boot, not first use — a bad key must not surface
// as a decrypt failure mid-request.
if (config.tokenEncryptionKey && !/^[0-9a-fA-F]{64}$/.test(config.tokenEncryptionKey)) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes) — refusing to start');
}

// #1 F1: an unset CORE_EVENTS_URL is deliberate drop-mode for dev and staged
// rollouts — but in production with the poll worker running it would SILENTLY
// and PERMANENTLY drop every inbound update: the forwarder's deliberate-skip
// `true` advances the getUpdates cursor, which deletes the updates on
// Telegram's side. A production env typo must stop the boot, not eat DMs. An
// operator who truly wants an ops-only instance sets DISABLE_POLL_WORKER=true.
if (isProduction && !config.disablePollWorker && !config.coreEventsUrl) {
  throw new Error(
    'CORE_EVENTS_URL is required in production while the poll worker is enabled — unset, inbound Telegram updates would be dropped silently (set DISABLE_POLL_WORKER=true for an ops-only instance) — refusing to start',
  );
}
