/**
 * Test doubles: an in-memory TelegramProvider fake with call recording, and
 * fixture builders. Route + poller tests run the real Express app / drain
 * loop + real test DB over these fakes — only Telegram is simulated.
 */
import type { Db } from '../db.js';
import type {
  TelegramProvider,
  TgMessage,
  TgUpdate,
  TgUser,
} from '../providers/botapi/types.js';

/** Wipe every table in FK-safe order — the one cleanup list all test files share. */
export async function resetDb(db: Db): Promise<void> {
  await db.idempotencyRecord.deleteMany();
  await db.connection.deleteMany();
}

/** The fake's bot identity (getMe). */
export function botUser(overrides: Partial<TgUser> = {}): TgUser {
  return {
    id: 7777,
    is_bot: true,
    first_name: 'Hadron Bot',
    username: 'hadron_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    ...overrides,
  };
}

/** Build a plausible inbound Telegram message fixture (a human DM by default). */
export function tgMessage(overrides: Partial<TgMessage> = {}): TgMessage {
  return {
    message_id: 100,
    from: { id: 555, is_bot: false, first_name: 'Raghvind', username: 'raghvind' },
    chat: { id: 555, type: 'private', first_name: 'Raghvind' },
    date: 1783000000,
    text: 'hello there',
    ...overrides,
  };
}

/** Wrap messages into getUpdates entries with ascending update_ids. */
export function updatesFrom(startId: number, ...messages: TgMessage[]): TgUpdate[] {
  return messages.map((message, i) => ({ update_id: startId + i, message }));
}

export interface FakeProviderOptions {
  /** getMe result override. */
  me?: TgUser;
  /** When set, the named methods throw this error. */
  failWith?: { methods: string[]; error: unknown };
}

/**
 * A recording fake provider. `calls` collects [method, args] tuples so tests
 * assert both HTTP behavior and what reached "Telegram". `pending` holds
 * queued updates; getUpdates returns those at/after the offset WITHOUT
 * removing them — mirroring Telegram's semantics, where an update is only
 * confirmed (deleted) once a HIGHER offset is requested.
 */
export function fakeProvider(options: FakeProviderOptions = {}): TelegramProvider & {
  calls: [string, unknown[]][];
  pending: TgUpdate[];
} {
  const calls: [string, unknown[]][] = [];
  const pending: TgUpdate[] = [];
  let nextMessageId = 9000;

  /** Record a call; throw if configured to fail. */
  function record(method: string, args: unknown[]): void {
    calls.push([method, args]);
    if (options.failWith?.methods.includes(method)) throw options.failWith.error;
  }

  const me = options.me ?? botUser();

  return {
    calls,
    pending,

    async getMe(botToken) {
      record('getMe', [botToken]);
      return me;
    },

    async sendMessage(botToken, params) {
      record('sendMessage', [botToken, params]);
      const numericChat = Number.parseInt(params.chat_id, 10);
      return {
        message_id: nextMessageId++,
        from: me,
        chat: { id: Number.isNaN(numericChat) ? 0 : numericChat, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: params.text,
        ...(params.message_thread_id != null ? { message_thread_id: params.message_thread_id } : {}),
        ...(params.reply_to_message_id != null
          ? { reply_to_message: { message_id: params.reply_to_message_id } }
          : {}),
      };
    },

    async editMessageText(botToken, params) {
      record('editMessageText', [botToken, params]);
      const numericChat = Number.parseInt(params.chat_id, 10);
      return {
        message_id: params.message_id,
        from: me,
        chat: { id: Number.isNaN(numericChat) ? 0 : numericChat, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: params.text,
      };
    },

    async deleteMessage(botToken, chatId, messageId) {
      record('deleteMessage', [botToken, chatId, messageId]);
    },

    async getChat(botToken, chatId) {
      record('getChat', [botToken, chatId]);
      const numericChat = Number.parseInt(chatId, 10);
      return { id: Number.isNaN(numericChat) ? 0 : numericChat, type: 'supergroup', title: 'EngTeamChat', is_forum: false };
    },

    async getChatMember(botToken, chatId, userId) {
      record('getChatMember', [botToken, chatId, userId]);
      return { status: 'member', user: { id: userId, is_bot: false, first_name: 'Member' } };
    },

    async getUpdates(botToken, offset, timeoutS) {
      record('getUpdates', [botToken, offset, timeoutS]);
      return pending.filter((u) => u.update_id >= offset);
    },
  };
}
