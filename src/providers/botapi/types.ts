/**
 * Provider-layer types + the injectable TelegramProvider interface.
 *
 * The ops layer (src/ops), the poll worker, and routes depend only on this
 * interface; tests inject a fake, and src/providers/botapi/client.ts is the
 * production implementation over the plain Bot API (raw fetch — spec 042
 * decision 5: no bot framework).
 */

/** Telegram user (or bot) as the Bot API returns it. */
export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  /** getMe-only fields (present when the user IS the queried bot). */
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
}

/** Telegram chat. `private` = DM; `group`/`supergroup` = group; `channel` = broadcast. */
export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
}

/** Telegram message — the subset this tool reads. */
export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TgUser;
  chat: TgChat;
  /** Unix timestamp (seconds). */
  date: number;
  text?: string;
  reply_to_message?: { message_id: number };
}

/** One getUpdates entry. Non-message update kinds are skipped by the poller. */
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  [key: string]: unknown;
}

/** getChatMember result — the subset the admin-validation path needs. */
export interface TgChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  user: TgUser;
}

/** sendMessage parameters (the v1 subset). */
export interface SendMessageParams {
  chat_id: string;
  text: string;
  message_thread_id?: number;
  reply_to_message_id?: number;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  disable_notification?: boolean;
}

/** editMessageText parameters. */
export interface EditMessageParams {
  chat_id: string;
  message_id: number;
  text: string;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
}

/**
 * A Bot API failure, thrown by the client with Telegram's error envelope
 * attached so src/errors.ts can map it to the typed catalog. `retryAfter`
 * carries `parameters.retry_after` on 429s.
 */
export class TelegramApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly description: string,
    public readonly retryAfter?: number,
  ) {
    super(`Telegram API ${status}: ${description}`);
  }
}

/**
 * Everything the tool needs from Telegram. One method per Bot API method;
 * every method takes the connection's decrypted bot token. Unlike Graph,
 * there is no token rotation — the bot token is static until revoked.
 */
export interface TelegramProvider {
  /** Validate a token + fetch the bot identity. Used at registration and by the get-me op. */
  getMe(botToken: string): Promise<TgUser>;
  sendMessage(botToken: string, params: SendMessageParams): Promise<TgMessage>;
  editMessageText(botToken: string, params: EditMessageParams): Promise<TgMessage>;
  deleteMessage(botToken: string, chatId: string, messageId: number): Promise<void>;
  getChat(botToken: string, chatId: string): Promise<TgChat>;
  getChatMember(botToken: string, chatId: string, userId: number): Promise<TgChatMember>;
  /** Long-poll for updates. `offset` confirms everything below it to Telegram — the caller controls advancement. */
  getUpdates(botToken: string, offset: number, timeoutS: number): Promise<TgUpdate[]>;
}
