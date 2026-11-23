/**
 * Idempotency completion tests (#1 F4): after a provider mutation succeeds,
 * the in-flight reservation is completed with `update … responseJson` — and
 * a DB failure of that completion used to be swallowed (`.catch(() => {})`).
 * The caller's success was already earned by the provider, but the record
 * stayed `responseJson: null` forever, so every future retry with the same
 * key was refused with "still in flight".
 *
 * The contract pinned here: a completion failure is RETRIED and, if it keeps
 * failing, SURFACED loudly (never swallowed, never thrown — throwing after a
 * successful send would make the caller re-send and duplicate the message).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptToken } from '../crypto.js';
import { db } from '../db.js';
import { runOperation } from './index.js';
import { fakeProvider, resetDb } from '../test/fakes.js';
import type { Db } from '../db.js';

/** Seed one ACTIVE connection; returns its id. */
async function seedConnection(): Promise<string> {
  const row = await db.connection.create({
    data: { botId: '7777', botUsername: 'hadron_test_bot', tokenEnc: encryptToken('raw-bot-token') },
  });
  return row.id;
}

/**
 * A db stand-in whose idempotencyRecord.update fails the first `failures`
 * calls (0 = never fail), passing everything else through to the real client.
 */
function withFailingCompletion(realDb: Db, failures: number): Db {
  let attempted = 0;
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop !== 'idempotencyRecord') return Reflect.get(target, prop, receiver);
      const model = Reflect.get(target, prop, receiver) as object;
      return new Proxy(model, {
        get(m, mProp, mReceiver) {
          if (mProp !== 'update') return Reflect.get(m, mProp, mReceiver);
          const orig = Reflect.get(m, mProp, mReceiver).bind(m) as (...a: unknown[]) => Promise<unknown>;
          return async (...args: unknown[]) => {
            attempted += 1;
            if (attempted <= failures) throw new Error('simulated completion write failure');
            return orig(...args);
          };
        },
      });
    },
  }) as Db;
}

const sendInput = (connectionId: string) => ({ connectionId, chatId: '555', text: 'hello' });

let consoleErrors: string[];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetDb(db);
  consoleErrors = [];
  spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => String(a)).join(' '));
  });
});

afterEach(() => {
  spy.mockRestore();
});

describe('idempotency completion after provider success (F4)', () => {
  it('surfaces a completion failure loudly instead of swallowing it', async () => {
    const provider = fakeProvider();
    const connectionId = await seedConnection();
    const flaky = withFailingCompletion(db, Number.POSITIVE_INFINITY);

    // The provider mutation succeeded, so the caller still gets its result.
    const { result, replayed } = await runOperation(flaky, provider, 'send-message', sendInput(connectionId), 'k-surface');
    expect(replayed).toBe(false);
    expect((result as { message: { text: string } }).message.text).toBe('hello');
    expect(provider.calls.filter(([m]) => m === 'sendMessage')).toHaveLength(1);

    // The stuck reservation is announced — named key, named operation.
    expect(consoleErrors.some((line) => /idempotency completion failed/.test(line) && line.includes('k-surface'))).toBe(
      true,
    );
  });

  it('repairs a transient completion failure: retried, completed, later replay works', async () => {
    const provider = fakeProvider();
    const connectionId = await seedConnection();
    const flaky = withFailingCompletion(db, 2);

    await runOperation(flaky, provider, 'send-message', sendInput(connectionId), 'k-repair');

    const row = await db.idempotencyRecord.findUnique({ where: { key: 'k-repair' } });
    expect(row!.responseJson).not.toBeNull();

    const again = await runOperation(flaky, provider, 'send-message', sendInput(connectionId), 'k-repair');
    expect(again.replayed).toBe(true);
    expect(provider.calls.filter(([m]) => m === 'sendMessage')).toHaveLength(1);
  });

  it('never fails the caller after the provider mutation succeeded', async () => {
    const provider = fakeProvider();
    const connectionId = await seedConnection();
    const flaky = withFailingCompletion(db, Number.POSITIVE_INFINITY);

    // Throwing here would make core retry a send that already happened —
    // a duplicate message. The failure must live in the log, not the response.
    await expect(runOperation(flaky, provider, 'send-message', sendInput(connectionId), 'k-never-throw')).resolves.toMatchObject({
      replayed: false,
    });
  });
});
