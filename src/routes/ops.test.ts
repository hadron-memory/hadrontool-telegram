/**
 * Operations-plane tests: real Express app + real test DB over the fake
 * provider. Covers the bearer gate, validation, the typed error mapping
 * (429/403/401 taxonomies), idempotent replay, and the synchronous-send
 * contract's visible surface.
 */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { encryptToken } from '../crypto.js';
import { db } from '../db.js';
import { TelegramApiError } from '../providers/botapi/types.js';
import { fakeProvider, resetDb } from '../test/fakes.js';

const AUTH = { authorization: 'Bearer test-tool-token' };
const noopForward = async () => true;

/** Seed one ACTIVE connection; returns its id. */
async function seedConnection(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = await db.connection.create({
    data: {
      botId: '7777',
      botUsername: 'hadron_test_bot',
      tokenEnc: encryptToken('raw-bot-token'),
      ...overrides,
    },
  });
  return row.id;
}

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /ops/:operation', () => {
  it('rejects requests without the bearer token', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const res = await request(app).post('/ops/send-message').send({});
    expect(res.status).toBe(401);
  });

  it('404s an unknown operation with the operation list', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const res = await request(app).post('/ops/launch-rocket').set(AUTH).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_operation');
    expect(res.body.operations).toContain('send-message');
  });

  it('send-message delivers via the provider and returns the normalized message', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider, noopForward);
    const connectionId = await seedConnection();

    const res = await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId, chatId: 555, text: 'inbox summary ready', replyToMessageId: 42 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.replayed).toBe(false);
    expect(res.body.message.chatId).toBe('555');
    expect(res.body.message.text).toBe('inbox summary ready');
    expect(res.body.message.replyToMessageId).toBe(42);

    // The decrypted token — not the ciphertext — reached "Telegram".
    const [method, args] = provider.calls.find(([m]) => m === 'sendMessage')!;
    expect(method).toBe('sendMessage');
    expect(args[0]).toBe('raw-bot-token');
    expect(args[1]).toMatchObject({ chat_id: '555', text: 'inbox summary ready', reply_to_message_id: 42 });
  });

  it('rejects text over the Bot API 4096-char cap as validation_error', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const connectionId = await seedConnection();
    const res = await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId, chatId: 555, text: 'x'.repeat(4097) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.field).toBe('text');
  });

  it('answers connection_not_found for an unknown connectionId', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const res = await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId: 'nope', chatId: 555, text: 'hi' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('connection_not_found');
  });

  it('maps a provider 429 to provider_rate_limited with retryAfterSeconds', async () => {
    const provider = fakeProvider({
      failWith: { methods: ['sendMessage'], error: new TelegramApiError(429, 'Too Many Requests', 17) },
    });
    const app = createApp(db, provider, noopForward);
    const connectionId = await seedConnection();
    const res = await request(app).post('/ops/send-message').set(AUTH).send({ connectionId, chatId: 555, text: 'hi' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('provider_rate_limited');
    expect(res.body.retryAfterSeconds).toBe(17);
  });

  it('maps a provider 403 to chat_forbidden (token fine, chat refuses)', async () => {
    const provider = fakeProvider({
      failWith: { methods: ['sendMessage'], error: new TelegramApiError(403, 'Forbidden: bot was blocked by the user') },
    });
    const app = createApp(db, provider, noopForward);
    const connectionId = await seedConnection();
    const res = await request(app).post('/ops/send-message').set(AUTH).send({ connectionId, chatId: 555, text: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('chat_forbidden');
  });

  it('marks the connection ERROR on a dead token and short-circuits afterwards', async () => {
    const provider = fakeProvider({
      failWith: { methods: ['sendMessage'], error: new TelegramApiError(401, 'Unauthorized') },
    });
    const app = createApp(db, provider, noopForward);
    const connectionId = await seedConnection();

    const first = await request(app).post('/ops/send-message').set(AUTH).send({ connectionId, chatId: 555, text: 'hi' });
    expect(first.status).toBe(403);
    expect(first.body.error).toBe('connection_unauthorized');

    const row = await db.connection.findUnique({ where: { id: connectionId } });
    expect(row!.status).toBe('ERROR');

    // Second call short-circuits before reaching the provider.
    const callsBefore = provider.calls.length;
    const second = await request(app).post('/ops/send-message').set(AUTH).send({ connectionId, chatId: 555, text: 'hi' });
    expect(second.body.error).toBe('connection_unauthorized');
    expect(provider.calls.length).toBe(callsBefore);
  });

  it('replays a completed idempotency key without touching Telegram again', async () => {
    const provider = fakeProvider();
    const app = createApp(db, provider, noopForward);
    const connectionId = await seedConnection();
    const body = { connectionId, chatId: 555, text: 'once only', idempotencyKey: 'key-1' };

    const first = await request(app).post('/ops/send-message').set(AUTH).send(body);
    expect(first.status).toBe(200);
    const sendsAfterFirst = provider.calls.filter(([m]) => m === 'sendMessage').length;

    const second = await request(app).post('/ops/send-message').set(AUTH).send(body);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.message.messageId).toBe(first.body.message.messageId);
    expect(provider.calls.filter(([m]) => m === 'sendMessage').length).toBe(sendsAfterFirst);
  });

  it('rejects an idempotency key reused with a different payload', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const connectionId = await seedConnection();
    await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId, chatId: 555, text: 'original', idempotencyKey: 'key-2' });
    const res = await request(app)
      .post('/ops/send-message')
      .set(AUTH)
      .send({ connectionId, chatId: 555, text: 'DIFFERENT', idempotencyKey: 'key-2' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.field).toBe('idempotencyKey');
  });

  it('releases the idempotency reservation on failure so a retry can execute', async () => {
    const provider = fakeProvider({
      failWith: { methods: ['sendMessage'], error: new TelegramApiError(500, 'boom') },
    });
    const app = createApp(db, provider, noopForward);
    const connectionId = await seedConnection();
    const body = { connectionId, chatId: 555, text: 'retry me', idempotencyKey: 'key-3' };

    const first = await request(app).post('/ops/send-message').set(AUTH).send(body);
    expect(first.status).toBe(502);

    const okProvider = fakeProvider();
    const okApp = createApp(db, okProvider, noopForward);
    const second = await request(okApp).post('/ops/send-message').set(AUTH).send(body);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(false);
  });

  it('get-me reports the LIVE privacy-exemption flag for binding validation', async () => {
    const provider = fakeProvider({
      me: { id: 7777, is_bot: true, first_name: 'Ear Bot', username: 'ear_bot', can_read_all_group_messages: true },
    });
    const app = createApp(db, provider, noopForward);
    const connectionId = await seedConnection();
    const res = await request(app).post('/ops/get-me').set(AUTH).send({ connectionId });
    expect(res.status).toBe(200);
    expect(res.body.bot.canReadAllGroupMessages).toBe(true);
    expect(res.body.bot.username).toBe('ear_bot');
  });

  it('get-chat-member computes isAdmin for the binding admin-fallback check', async () => {
    const provider = fakeProvider();
    provider.getChatMember = async () => ({
      status: 'administrator',
      user: { id: 7777, is_bot: true, first_name: 'Ear Bot' },
    });
    const app = createApp(db, provider, noopForward);
    const connectionId = await seedConnection();
    const res = await request(app)
      .post('/ops/get-chat-member')
      .set(AUTH)
      .send({ connectionId, chatId: -100123, userId: 7777 });
    expect(res.status).toBe(200);
    expect(res.body.member.isAdmin).toBe(true);
  });
});
