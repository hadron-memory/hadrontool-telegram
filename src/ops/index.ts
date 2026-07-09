/**
 * Provider-neutral operations — the spec 042 contract surface, following the
 * spec 002 shape. hadron-server's telegramClient calls POST /ops/<name>;
 * nothing Bot-API-shaped leaks out of this layer (TgMessage is normalized to
 * the same TelegramMessage shape the event plane uses, so the pull and push
 * surfaces cannot drift apart silently).
 *
 * v1 operations: send-message, edit-message, delete-message, get-chat,
 * get-chat-member, get-me. Media operations are additive later.
 *
 * Every operation's input is validated ONCE against its single schema
 * (defineOp parses before the handler runs), then executed through
 * withConnection (src/connectionCall.ts) — the shared load/decrypt/error-map
 * lifecycle. Send-class operations reserve a pacing slot first and are
 * SYNCHRONOUS: a 2xx response means Telegram confirmed delivery (spec 042 —
 * the tool never acks an undelivered message).
 */
import { createHash } from 'crypto';
import { z } from 'zod';
import { withConnection } from '../connectionCall.js';
import type { Db } from '../db.js';
import {
  ProviderRateLimitedError,
  TelegramToolError,
  ValidationError,
  mapTelegramError,
  validationFromZod,
} from '../errors.js';
import { recordProviderBackoff, reserveSendSlot } from '../pacing.js';
import type { TelegramProvider, TgMessage } from '../providers/botapi/types.js';

/** Provider-neutral message shape — identical to the event plane's fields. */
export interface TelegramMessage {
  messageId: number;
  chatId: string;
  messageThreadId: number | null;
  from: { telegramUserId: string; username: string | null; displayName: string; isBot: boolean } | null;
  text: string;
  replyToMessageId: number | null;
  sentAt: string;
}

/** Normalize a Bot API message to the neutral shape. */
export function normalizeMessage(m: TgMessage): TelegramMessage {
  return {
    messageId: m.message_id,
    chatId: String(m.chat.id),
    messageThreadId: m.message_thread_id ?? null,
    from: m.from
      ? {
          telegramUserId: String(m.from.id),
          username: m.from.username ?? null,
          displayName: [m.from.first_name, m.from.last_name].filter(Boolean).join(' '),
          isBot: m.from.is_bot,
        }
      : null,
    text: m.text ?? '',
    replyToMessageId: m.reply_to_message?.message_id ?? null,
    sentAt: new Date(m.date * 1000).toISOString(),
  };
}

/** One operation: the single input schema + the handler over parsed input. */
export interface OperationDef {
  mutating: boolean;
  schema: z.ZodType;
  run(db: Db, provider: TelegramProvider, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Define an operation with ONE schema: defineOp parses the raw input against
 * it and hands the handler the typed result — there is no second, shadow
 * schema inside the handler to drift from the declared contract.
 */
function defineOp<S extends z.ZodType>(
  mutating: boolean,
  schema: S,
  handler: (db: Db, provider: TelegramProvider, input: z.infer<S>) => Promise<unknown>,
): OperationDef {
  return {
    mutating,
    schema,
    run: (db, provider, raw) => handler(db, provider, schema.parse(raw)),
  };
}

/** Telegram chat ids are int64 (or "@channelusername") — normalized to string. */
const chatIdSchema = z.union([z.string().min(1), z.number().int()]).transform(String);

const connectionIdSchema = z.object({ connectionId: z.string().min(1) });
const chatRefSchema = connectionIdSchema.extend({ chatId: chatIdSchema });
const parseModeSchema = z.enum(['HTML', 'Markdown', 'MarkdownV2']);

const sendMessageSchema = chatRefSchema.extend({
  /** Bot API sendMessage caps text at 4096 chars — chunking is the CALLER's concern. */
  text: z.string().min(1).max(4096),
  replyToMessageId: z.number().int().optional(),
  messageThreadId: z.number().int().optional(),
  parseMode: parseModeSchema.optional(),
  disableNotification: z.boolean().optional(),
});

const editMessageSchema = chatRefSchema.extend({
  messageId: z.number().int(),
  text: z.string().min(1).max(4096),
  parseMode: parseModeSchema.optional(),
});

const deleteMessageSchema = chatRefSchema.extend({ messageId: z.number().int() });
const getChatMemberSchema = chatRefSchema.extend({ userId: z.number().int() });

/**
 * Run a send-class provider call with pacing: reserve the per-chat slot,
 * record any provider 429 as chat backoff, and rethrow typed.
 */
async function pacedSend<T>(connectionId: string, chatId: string, fn: () => Promise<T>): Promise<T> {
  await reserveSendSlot(connectionId, chatId);
  try {
    return await fn();
  } catch (err) {
    const mapped = mapTelegramError(err, { resource: 'chat', id: chatId });
    if (mapped instanceof ProviderRateLimitedError) {
      recordProviderBackoff(connectionId, chatId, mapped.retryAfterSeconds);
    }
    throw mapped;
  }
}

/** The v1 operation registry, keyed by spec 042 operation name. */
export const OPERATIONS: Record<string, OperationDef> = {
  'send-message': defineOp(true, sendMessageSchema, async (db, provider, input) => {
    const message = await withConnection(db, input.connectionId, { resource: 'chat', id: input.chatId }, (token) =>
      pacedSend(input.connectionId, input.chatId, () =>
        provider.sendMessage(token, {
          chat_id: input.chatId,
          text: input.text,
          ...(input.replyToMessageId != null ? { reply_to_message_id: input.replyToMessageId } : {}),
          ...(input.messageThreadId != null ? { message_thread_id: input.messageThreadId } : {}),
          ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
          ...(input.disableNotification != null ? { disable_notification: input.disableNotification } : {}),
        }),
      ),
    );
    return { message: normalizeMessage(message) };
  }),

  'edit-message': defineOp(true, editMessageSchema, async (db, provider, input) => {
    const message = await withConnection(
      db,
      input.connectionId,
      { resource: 'message', id: String(input.messageId) },
      (token) =>
        pacedSend(input.connectionId, input.chatId, () =>
          provider.editMessageText(token, {
            chat_id: input.chatId,
            message_id: input.messageId,
            text: input.text,
            ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
          }),
        ),
    );
    return { message: normalizeMessage(message) };
  }),

  'delete-message': defineOp(true, deleteMessageSchema, async (db, provider, input) => {
    await withConnection(db, input.connectionId, { resource: 'message', id: String(input.messageId) }, (token) =>
      provider.deleteMessage(token, input.chatId, input.messageId),
    );
    return { deleted: true };
  }),

  'get-chat': defineOp(false, chatRefSchema, async (db, provider, input) => {
    const chat = await withConnection(db, input.connectionId, { resource: 'chat', id: input.chatId }, (token) =>
      provider.getChat(token, input.chatId),
    );
    return {
      chat: {
        chatId: String(chat.id),
        type: chat.type,
        title: chat.title ?? null,
        username: chat.username ?? null,
        isForum: chat.is_forum ?? false,
      },
    };
  }),

  'get-chat-member': defineOp(false, getChatMemberSchema, async (db, provider, input) => {
    const member = await withConnection(db, input.connectionId, { resource: 'member', id: String(input.userId) }, (token) =>
      provider.getChatMember(token, input.chatId, input.userId),
    );
    return {
      member: {
        status: member.status,
        telegramUserId: String(member.user.id),
        username: member.user.username ?? null,
        isAdmin: member.status === 'administrator' || member.status === 'creator',
      },
    };
  }),

  // Live bot identity — core's group-binding validation reads
  // canReadAllGroupMessages from HERE (privacy mode can change after
  // registration; the Connection row's copy is registration-time metadata).
  'get-me': defineOp(false, connectionIdSchema, async (db, provider, input) => {
    const me = await withConnection(db, input.connectionId, undefined, (token) => provider.getMe(token));
    return {
      bot: {
        botId: String(me.id),
        username: me.username ?? null,
        displayName: [me.first_name, me.last_name].filter(Boolean).join(' '),
        canReadAllGroupMessages: me.can_read_all_group_messages ?? false,
        canJoinGroups: me.can_join_groups ?? false,
      },
    };
  }),
};

/** Recursively key-sort a value so semantically equal inputs hash equal. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, canonical(val)]),
    );
  }
  return v;
}

/** Stable SHA-256 of an operation input for idempotency-payload matching. */
function hashInput(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

/** Prisma unique-violation check (P2002) — anything else is a real DB error. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/**
 * Execute an operation by name with reservation-based idempotency: a
 * mutating call carrying an `idempotencyKey` first INSERTS an in-flight
 * reservation (unique key), so a concurrent duplicate cannot also execute
 * the provider mutation — it sees the reservation and is told to retry. A
 * completed key replays the stored response; a key reused with a different
 * operation or payload is rejected instead of leaking the stored response.
 */
export async function runOperation(
  db: Db,
  provider: TelegramProvider,
  name: string,
  input: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ result: unknown; replayed: boolean }> {
  const op = OPERATIONS[name];
  if (!op) throw new ValidationError('operation', `unknown operation "${name}"`);

  const useIdempotency = Boolean(idempotencyKey) && op.mutating;
  const requestHash = useIdempotency ? hashInput(input) : '';

  if (useIdempotency) {
    try {
      await db.idempotencyRecord.create({
        data: { key: idempotencyKey!, operation: name, requestHash, responseJson: null },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await db.idempotencyRecord.findUnique({ where: { key: idempotencyKey! } });
      if (!existing) throw new ValidationError('idempotencyKey', 'key state changed concurrently — retry');
      if (existing.operation !== name || existing.requestHash !== requestHash) {
        throw new ValidationError('idempotencyKey', 'key was already used for a different request');
      }
      if (existing.responseJson == null) {
        throw new ValidationError('idempotencyKey', 'a request with this key is still in flight — retry shortly');
      }
      return { result: JSON.parse(existing.responseJson), replayed: true };
    }
  }

  let result: unknown;
  try {
    result = await op.run(db, provider, input);
  } catch (err) {
    // Release the reservation so the caller's retry can execute.
    if (useIdempotency) {
      await db.idempotencyRecord.delete({ where: { key: idempotencyKey! } }).catch(() => {});
    }
    if (err instanceof z.ZodError) throw validationFromZod(err);
    if (err instanceof TelegramToolError) throw err;
    throw mapTelegramError(err);
  }

  if (useIdempotency) {
    await db.idempotencyRecord
      .update({ where: { key: idempotencyKey! }, data: { responseJson: JSON.stringify(result) } })
      .catch(() => {});
  }
  return { result, replayed: false };
}
