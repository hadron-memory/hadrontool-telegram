/**
 * Connection-plane tests: registration validates the token live via getMe,
 * the bot token never appears in a response, duplicate active bots are
 * refused (competing pollers ⇒ Telegram 409s), and soft-delete frees the
 * bot for re-registration.
 */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { decryptToken } from '../crypto.js';
import { db } from '../db.js';
import { TelegramApiError } from '../providers/botapi/types.js';
import { botUser, fakeProvider, resetDb } from '../test/fakes.js';

const AUTH = { authorization: 'Bearer test-tool-token' };
const noopForward = async () => true;

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /connections', () => {
  it('registers a bot: validates via getMe, stores the token encrypted, returns identity only', async () => {
    const provider = fakeProvider({ me: botUser({ can_read_all_group_messages: true }) });
    const app = createApp(db, provider, noopForward);

    const res = await request(app).post('/connections').set(AUTH).send({ botToken: '7777:AAAbbbCCC' });

    expect(res.status).toBe(201);
    expect(res.body.botId).toBe('7777');
    expect(res.body.botUsername).toBe('hadron_test_bot');
    expect(res.body.canReadAllGroupMessages).toBe(true);
    expect(res.body.status).toBe('ACTIVE');
    // The token appears NOWHERE in the response.
    expect(JSON.stringify(res.body)).not.toContain('AAAbbbCCC');

    const row = await db.connection.findUnique({ where: { id: res.body.id } });
    expect(row!.tokenEnc).not.toContain('AAAbbbCCC');
    expect(decryptToken(row!.tokenEnc)).toBe('7777:AAAbbbCCC');
  });

  it('rejects a token Telegram refuses as a validation error, not connection_unauthorized', async () => {
    const provider = fakeProvider({
      failWith: { methods: ['getMe'], error: new TelegramApiError(401, 'Unauthorized') },
    });
    const app = createApp(db, provider, noopForward);
    const res = await request(app).post('/connections').set(AUTH).send({ botToken: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.field).toBe('botToken');
  });

  it('refuses a second active connection for the same bot', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    await request(app).post('/connections').set(AUTH).send({ botToken: 't-1' });
    const res = await request(app).post('/connections').set(AUTH).send({ botToken: 't-1' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toContain('already exists');
  });

  it('allows re-registration after disconnect', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const first = await request(app).post('/connections').set(AUTH).send({ botToken: 't-1' });
    await request(app).delete(`/connections/${first.body.id}`).set(AUTH);
    const second = await request(app).post('/connections').set(AUTH).send({ botToken: 't-1' });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });
});

describe('GET/DELETE /connections/:id', () => {
  it('returns identity + poll state, and 404s unknown or deleted connections', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const created = await request(app).post('/connections').set(AUTH).send({ botToken: 't-1' });

    const got = await request(app).get(`/connections/${created.body.id}`).set(AUTH);
    expect(got.status).toBe(200);
    expect(got.body.botUsername).toBe('hadron_test_bot');
    expect(got.body.pollingEnabled).toBe(true);
    expect(got.body.lastUpdateId).toBe(0);

    expect((await request(app).get('/connections/nope').set(AUTH)).status).toBe(404);

    const del = await request(app).delete(`/connections/${created.body.id}`).set(AUTH);
    expect(del.body.deleted).toBe(true);
    expect((await request(app).get(`/connections/${created.body.id}`).set(AUTH)).status).toBe(404);
  });
});
