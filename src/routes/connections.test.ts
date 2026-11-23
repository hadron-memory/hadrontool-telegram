/**
 * Connection-plane tests: registration validates the token live via getMe,
 * the bot token never appears in a response, duplicate active bots are
 * refused (competing pollers ⇒ Telegram 409s), and soft-delete frees the
 * bot for re-registration.
 */
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('POST /connections registrationKey (#5, tool half of hadron-server#4829)', () => {
  const KEY = 'k'.repeat(32);
  const OTHER = 'z'.repeat(32);
  const post = (app: ReturnType<typeof createApp>, body: Record<string, unknown>) =>
    request(app).post('/connections').set(AUTH).send({ botToken: 't-1', ...body });

  it('the same key twice returns the one connection (200, same body as 201) and leaves one row', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const first = await post(app, { registrationKey: KEY });
    const second = await post(app, { registrationKey: KEY });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await db.connection.count({ where: { deletedAt: null } })).toBe(1);
  });

  it('a different key is refused with 400, and the refusal names no connection id', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const first = await post(app, { registrationKey: KEY });
    const res = await post(app, { registrationKey: OTHER });
    expect(res.status).toBe(400);
    expect(res.body.reason).toContain('already exists');
    expect(JSON.stringify(res.body)).not.toContain(first.body.id);
  });

  it('a legacy row with no key is refused for a keyed caller, without its id', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const legacy = await post(app, {});
    const res = await post(app, { registrationKey: KEY });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(legacy.body.id);
    expect(await db.connection.count({ where: { deletedAt: null } })).toBe(1);
  });

  it('a keyless caller is refused against a keyed row, without its id (no key: unchanged)', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const keyed = await post(app, { registrationKey: KEY });
    const res = await post(app, {});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(keyed.body.id);
  });

  it('never adopts a deleted connection: the same key after teardown registers a new one', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const first = await post(app, { registrationKey: KEY });
    await request(app).delete(`/connections/${first.body.id}`).set(AUTH);
    const again = await post(app, { registrationKey: KEY });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(first.body.id);
    const old = await db.connection.findUnique({ where: { id: first.body.id } });
    expect(old!.deletedAt).not.toBeNull();
  });

  it('the key appears in no response and no log line, and the refusal and 200 do not echo it', async () => {
    const lines: string[] = [];
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')].map((s) =>
      s.mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' '))),
    );
    try {
      const app = createApp(db, fakeProvider(), noopForward);
      const bodies = [
        (await post(app, { registrationKey: KEY })).body,
        (await post(app, { registrationKey: KEY })).body,
        (await post(app, { registrationKey: OTHER })).body,
        (await post(app, { registrationKey: 'short' })).body,
      ];
      for (const b of bodies) expect(JSON.stringify(b)).not.toMatch(new RegExp(`${KEY}|${OTHER}`));
      expect(lines.join('\n')).not.toMatch(new RegExp(`${KEY}|${OTHER}`));
      const row = await db.connection.findFirst({ where: { deletedAt: null } });
      expect(Object.values(row!).map(String).join('|')).not.toContain(KEY);
      expect(row!.registrationKeyHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('a key outside 16-128 characters (or not a string) is a validation error', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    for (const bad of ['x'.repeat(15), 'x'.repeat(129), 42, '']) {
      const res = await post(app, { registrationKey: bad });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('registrationKey');
    }
    expect(await db.connection.count()).toBe(0);
    expect((await post(app, { registrationKey: 'x'.repeat(16) })).status).toBe(201);
  });

  it('concurrent registrations with the same key converge on one row', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => i).map(() => post(app, { registrationKey: KEY })));
    expect(results.map((r) => r.status).sort()).toEqual([...Array(11).fill(200), 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await db.connection.count({ where: { deletedAt: null } })).toBe(1);
  });
});

describe('registrationKey with ill-formed Unicode (local review P2)', () => {
  it('a lone surrogate never aliases another key: it is a validation error, and U+FFFD does not adopt', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const good = 'a'.repeat(20) + '\uFFFD';
    const first = await request(app).post('/connections').set(AUTH).send({ botToken: 't-1', registrationKey: good });
    expect(first.status).toBe(201);
    // Raw JSON so the lone surrogate survives to the server as \ud800.
    const bad = await request(app)
      .post('/connections')
      .set(AUTH)
      .set('content-type', 'application/json')
      .send(`{"botToken":"t-1","registrationKey":"${'a'.repeat(20)}\\ud800"}`);
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('registrationKey');
    expect(JSON.stringify(bad.body)).not.toContain(first.body.id);
  });
});

describe('registration is serialized per bot (advisory lock)', () => {
  it('a registration waits while another transaction holds the bot lock, then proceeds', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'telegram-register:7777'}))`;
        locked();
        await gate;
      },
      { timeout: 10_000 },
    );
    await held;
    let done = false;
    const pending = request(app)
      .post('/connections')
      .set(AUTH)
      .send({ botToken: 't-1' })
      .then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await holder;
    expect((await pending).status).toBe(201);
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

describe('a repeat DELETE answers success for a connection already deleted (#8, tool half of hadron-server#4847)', () => {
  it('answers 200 {deleted:true} again and leaves deletedAt exactly as the first delete set it', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const created = await request(app).post('/connections').set(AUTH).send({ botToken: 't-1' });
    expect((await request(app).delete(`/connections/${created.body.id}`).set(AUTH)).body.deleted).toBe(true);
    const first = (await db.connection.findUniqueOrThrow({ where: { id: created.body.id } })).deletedAt;
    expect(first).not.toBeNull();
    const again = await request(app).delete(`/connections/${created.body.id}`).set(AUTH);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ deleted: true });
    expect((await db.connection.findUniqueOrThrow({ where: { id: created.body.id } })).deletedAt).toEqual(first);
  });

  it('an id the tool never held is still 404, with the same body as a GET of it', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const del = await request(app).delete('/connections/never-held').set(AUTH);
    expect(del.status).toBe(404);
    expect(del.body).toEqual((await request(app).get('/connections/never-held').set(AUTH)).body);
  });

  it('two concurrent first DELETEs both answer success, and exactly ONE guarded write wins (the loser sees count 0)', async () => {
    const app = createApp(db, fakeProvider(), noopForward);
    const created = await request(app).post('/connections').set(AUTH).send({ botToken: 't-1' });
    const original = db.connection.updateMany.bind(db.connection);
    const counts: number[] = [];
    const guarded = vi.spyOn(db.connection, 'updateMany').mockImplementation(((args: never) =>
      original(args).then((r: { count: number }) => {
        counts.push(r.count);
        return r;
      })) as never);
    let results: request.Response[];
    try {
      results = await Promise.all(Array.from({ length: 6 }, () => request(app).delete(`/connections/${created.body.id}`).set(AUTH)));
    } finally {
      guarded.mockRestore();
    }
    const outcomes = counts.map((count) => ({ count }));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(outcomes).toHaveLength(6);
    expect(outcomes.filter((o) => o.count === 1)).toHaveLength(1);
    expect(outcomes.filter((o) => o.count === 0)).toHaveLength(5);
  });
});
