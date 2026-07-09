/**
 * Production TelegramProvider over the plain Bot API — raw fetch, no bot
 * framework (spec 042 decision 5). Every call is
 * `POST {base}/bot{token}/{method}` with a JSON body; Telegram answers
 * `{ok: true, result}` or `{ok: false, error_code, description, parameters?}`.
 *
 * Failures throw TelegramApiError with the envelope attached; mapping to the
 * typed public catalog happens in src/errors.ts — nothing Telegram-shaped
 * leaks past the ops layer.
 */
import { config } from '../../config.js';
import {
  type EditMessageParams,
  type SendMessageParams,
  TelegramApiError,
  type TelegramProvider,
  type TgChat,
  type TgChatMember,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from './types.js';

/** Telegram's error envelope. */
interface TgErrorBody {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** Call one Bot API method; unwrap the result or throw TelegramApiError. */
async function call<T>(botToken: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
  let res: Response;
  let body: { ok: boolean; result?: T } & Partial<TgErrorBody>;
  try {
    res = await fetch(`${config.telegramApiBase}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = (await res.json()) as typeof body;
  } catch (err) {
    // Network failure / timeout / non-JSON body — transient by default.
    throw new TelegramApiError(0, `network failure calling ${method}: ${String(err)}`);
  }
  if (!body.ok) {
    throw new TelegramApiError(
      body.error_code ?? res.status,
      body.description ?? `Bot API ${method} failed (${res.status})`,
      body.parameters?.retry_after,
    );
  }
  return body.result as T;
}

/** Default per-call HTTP timeout; getUpdates adds the long-poll window on top. */
const CALL_TIMEOUT_MS = 15_000;

export const telegramProvider: TelegramProvider = {
  async getMe(botToken) {
    return call<TgUser>(botToken, 'getMe', {}, CALL_TIMEOUT_MS);
  },

  async sendMessage(botToken, params: SendMessageParams) {
    return call<TgMessage>(botToken, 'sendMessage', { ...params }, CALL_TIMEOUT_MS);
  },

  async editMessageText(botToken, params: EditMessageParams) {
    return call<TgMessage>(botToken, 'editMessageText', { ...params }, CALL_TIMEOUT_MS);
  },

  async deleteMessage(botToken, chatId, messageId) {
    await call<boolean>(botToken, 'deleteMessage', { chat_id: chatId, message_id: messageId }, CALL_TIMEOUT_MS);
  },

  async getChat(botToken, chatId) {
    return call<TgChat>(botToken, 'getChat', { chat_id: chatId }, CALL_TIMEOUT_MS);
  },

  async getChatMember(botToken, chatId, userId) {
    return call<TgChatMember>(botToken, 'getChatMember', { chat_id: chatId, user_id: userId }, CALL_TIMEOUT_MS);
  },

  async getUpdates(botToken, offset, timeoutS) {
    return call<TgUpdate[]>(
      botToken,
      'getUpdates',
      { offset, timeout: timeoutS, allowed_updates: ['message'] },
      // The HTTP timeout must outlive Telegram's long-poll hold.
      (timeoutS + 10) * 1000,
    );
  },
};
