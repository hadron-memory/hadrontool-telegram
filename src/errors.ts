/**
 * Typed error catalog — the spec 042 contract, following the spec 002 shape.
 *
 * Codes are the PUBLIC surface: hadron-server's telegramClient passes them
 * through to GraphQL `extensions.code` / MCP errors verbatim, so their
 * meanings must stay stable. New codes may be added; existing ones never
 * change meaning.
 */
import { TelegramApiError } from './providers/botapi/types.js';

/** Base class: every tool error carries a stable `code` + HTTP status. */
export abstract class TelegramToolError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  /** JSON body shape every error response uses. */
  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extraFields() };
  }

  protected extraFields(): Record<string, unknown> {
    return {};
  }
}

/** connectionId unknown OR soft-deleted — indistinguishable by design (anti-enumeration). */
export class ConnectionNotFoundError extends TelegramToolError {
  readonly code = 'connection_not_found';
  readonly httpStatus = 404;
  constructor() {
    super('This Telegram connection no longer exists.');
  }
}

/** Connection exists but its bot token is dead (revoked in BotFather). */
export class ConnectionUnauthorizedError extends TelegramToolError {
  readonly code = 'connection_unauthorized';
  readonly httpStatus = 403;
  constructor() {
    super('The bot token is no longer valid; the bot must be re-registered.');
  }
}

/**
 * The bot cannot act in this chat: blocked by the user, kicked from the
 * group, or the user never started the DM. Distinct from
 * connection_unauthorized — the TOKEN is fine, the CHAT relationship is not.
 */
export class ChatForbiddenError extends TelegramToolError {
  readonly code = 'chat_forbidden';
  readonly httpStatus = 403;
  constructor(public detail: string) {
    super(`The bot cannot act in this chat: ${detail}`);
  }
  protected extraFields() {
    return { detail: this.detail };
  }
}

/** Provider 429 — caller should retry after the indicated delay. */
export class ProviderRateLimitedError extends TelegramToolError {
  readonly code = 'provider_rate_limited';
  readonly httpStatus = 429;
  constructor(public retryAfterSeconds: number) {
    super('Telegram is rate-limiting; retry shortly.');
  }
  protected extraFields() {
    return { retryAfterSeconds: this.retryAfterSeconds };
  }
}

/** Provider 5xx / network failure — transient, caller may retry with backoff. */
export class ProviderUnavailableError extends TelegramToolError {
  readonly code = 'provider_unavailable';
  readonly httpStatus = 502;
  constructor() {
    super('Telegram is temporarily unavailable.');
  }
}

/** A chat/message/member id does not exist (or is not visible to this bot). */
export class NotFoundError extends TelegramToolError {
  readonly code = 'not_found';
  readonly httpStatus = 404;
  constructor(
    public resource: 'chat' | 'message' | 'member',
    public id: string,
  ) {
    super(`The ${resource} is no longer available.`);
  }
  protected extraFields() {
    return { resource: this.resource, id: this.id };
  }
}

/** Input failed schema or semantic validation. */
export class ValidationError extends TelegramToolError {
  readonly code = 'validation_error';
  readonly httpStatus = 400;
  constructor(
    public field: string,
    public reason: string,
  ) {
    super(`This request couldn't be processed: ${reason}`);
  }
  protected extraFields() {
    return { field: this.field, reason: this.reason };
  }
}

/**
 * Build a ValidationError from a zod failure — the ONE place the
 * first-issue/path-join convention lives; `field`/`reason` are part of the
 * stable public error contract, so every plane must flatten identically.
 */
export function validationFromZod(err: { issues: { path: PropertyKey[]; message: string }[] }): ValidationError {
  const issue = err.issues[0];
  return new ValidationError(issue?.path.map(String).join('.') || 'input', issue?.message ?? 'invalid input');
}

/** Optional hint improving not_found error payloads. */
export type ResourceHint = { resource: 'chat' | 'message' | 'member'; id: string } | undefined;

/**
 * Map a raw Bot API / fetch failure to a typed TelegramToolError. Anything
 * already typed passes through; unknown shapes become provider_unavailable
 * (transient by default — never pretend success).
 *
 * Bot API error taxonomy: 401 = dead token; 403 = the CHAT refuses the bot
 * (blocked/kicked/never-started) — the token itself is fine; 400 with a
 * "not found"-flavored description = bad chat/message id; 429 carries
 * parameters.retry_after.
 */
export function mapTelegramError(err: unknown, resourceHint?: ResourceHint): TelegramToolError {
  if (err instanceof TelegramToolError) return err;
  if (!(err instanceof TelegramApiError)) return new ProviderUnavailableError();

  if (err.status === 401) return new ConnectionUnauthorizedError();
  if (err.status === 403) return new ChatForbiddenError(err.description);
  if (err.status === 429) {
    return new ProviderRateLimitedError(err.retryAfter && err.retryAfter > 0 ? err.retryAfter : 30);
  }
  if (err.status === 400) {
    if (/not found/i.test(err.description)) {
      const resource = /message/i.test(err.description) ? 'message' : (resourceHint?.resource ?? 'chat');
      return new NotFoundError(resource, resourceHint?.id ?? 'unknown');
    }
    return new ValidationError('request', err.description);
  }
  return new ProviderUnavailableError();
}
