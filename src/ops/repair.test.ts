/**
 * Repair path for a wedged idempotency key (#11, deferred from #10 BLIND F7).
 *
 * A key wedges when the completion write keeps failing after the provider
 * mutation SUCCEEDED (runOperation surfaces it and leaves responseJson NULL),
 * or when the process dies around the reservation. Same-key retries are then
 * refused ("still in flight") forever. The repair path resolves the wedge
 * under an explicit human confirmation:
 *
 *  - 'complete' writes a repair marker as the stored response: same-key
 *    retries REPLAY the marker instead of being refused — no re-send.
 *  - 'clear' deletes the reservation: the next same-key request RE-EXECUTES
 *    the operation (a duplicate send if the original mutation happened — the
 *    operator's confirmed call, warned in the dry run).
 *
 * Interlocks: no repair without confirmation, none for a row still young
 * enough to be genuinely in flight, none for an already-completed key.
 *
 * Red-first: on main (pre-#11) none of this existed — the module import
 * itself failed, which is the point: there was no repair path at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptToken } from '../crypto.js';
import { db } from '../db.js';
import type { Db } from '../db.js';
import { runOperation } from './index.js';
import { listWedgedKeys, repairWedgedKey } from './repair.js';
import { fakeProvider, resetDb } from '../test/fakes.js';

/** Seed one ACTIVE connection; returns its id. */
async function seedConnection(): Promise<string> {
  const row = await db.connection.create({
    data: { botId: '7777', botUsername: 'hadron_test_bot', tokenEnc: encryptToken('raw-bot-token') },
  });
  return row.id;
}

/**
 * A db stand-in whose idempotencyRecord.update always fails, passing
 * everything else through — the wedge maker (completion window exhausted).
 */
function withWedgingCompletion(realDb: Db): Db {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop !== 'idempotencyRecord') return Reflect.get(target, prop, receiver);
      const model = Reflect.get(target, prop, receiver) as object;
      return new Proxy(model, {
        get(m, mProp, mReceiver) {
          if (mProp !== 'update') return Reflect.get(m, mProp, mReceiver);
          return async (...args: unknown[]) => {
            throw new Error('simulated completion write failure');
          };
        },
      });
    },
  }) as Db;
}

/**
 * A db stand-in that lands a REAL completion between repairWedgedKey's read
 * and its first guarded write: the first updateMany/deleteMany call first
 * stores a response on the row (the concurrent winner), then delegates.
 * Pins the responseJson:null write guard (LOCAL F1): without it the guarded
 * write matches the now-completed row and clobbers it.
 */
function withCompletionBetweenReadAndWrite(realDb: Db): Db {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop !== 'idempotencyRecord') return Reflect.get(target, prop, receiver);
      const model = Reflect.get(target, prop, receiver) as object;
      let injected = false;
      return new Proxy(model, {
        get(m, mProp, mReceiver) {
          if (mProp !== 'updateMany' && mProp !== 'deleteMany') return Reflect.get(m, mProp, mReceiver);
          const orig = Reflect.get(m, mProp, mReceiver) as (arg: { where: { key: string } }) => Promise<unknown>;
          return async (arg: { where: { key: string } }) => {
            if (!injected) {
              injected = true;
              await realDb.idempotencyRecord.update({
                where: { key: arg.where.key },
                data: { responseJson: '{"message":{"concurrentWinner":true}}' },
              });
            }
            return orig(arg);
          };
        },
      });
    },
  }) as Db;
}

/**
 * A db stand-in that deletes the row and RE-RESERVES the same key (no
 * response) between repairWedgedKey's read and its first guarded write. Pins
 * the row-identity terms in the where clause (BLIND F1): {key, responseJson:
 * null} alone would match the new live reservation — complete would write the
 * marker over it, clear would delete it.
 *
 * Which term separates the re-reservation from the judged row is the point
 * (local-delta P2). `requestHash: 'original'` re-reserves with the SAME hash
 * and a fresh createdAt — the realistic same-key same-PAYLOAD retry, where
 * only the createdAt term can refuse the write (a guard without createdAt
 * clobbers the live reservation). `createdAt: 'original'` is the mirror: a
 * different hash reusing the judged row's createdAt, where only the
 * requestHash term refuses it. The default (both fresh) is the realistic
 * different-payload retry, which either term catches.
 */
function withResurrectionBetweenReadAndWrite(
  realDb: Db,
  opts: { requestHash?: 'original' | 'fresh'; createdAt?: 'original' | 'fresh' } = {},
): Db {
  const hashMode = opts.requestHash ?? 'fresh';
  const createdMode = opts.createdAt ?? 'fresh';
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop !== 'idempotencyRecord') return Reflect.get(target, prop, receiver);
      const model = Reflect.get(target, prop, receiver) as object;
      let injected = false;
      return new Proxy(model, {
        get(m, mProp, mReceiver) {
          if (mProp !== 'updateMany' && mProp !== 'deleteMany') return Reflect.get(m, mProp, mReceiver);
          const orig = Reflect.get(m, mProp, mReceiver) as (arg: { where: { key: string } }) => Promise<unknown>;
          return async (arg: { where: { key: string } }) => {
            if (!injected) {
              injected = true;
              const judged = await realDb.idempotencyRecord.findUnique({ where: { key: arg.where.key } });
              await realDb.idempotencyRecord.delete({ where: { key: arg.where.key } });
              await realDb.idempotencyRecord.create({
                data: {
                  key: arg.where.key,
                  operation: 'send-message',
                  requestHash: hashMode === 'original' ? judged!.requestHash : 're-reserved',
                  responseJson: null,
                  createdAt: createdMode === 'original' ? judged!.createdAt : new Date(),
                },
              });
            }
            return orig(arg);
          };
        },
      });
    },
  }) as Db;
}

const sendInput = (connectionId: string) => ({ connectionId, chatId: '555', text: 'hello' });

/** Wedge one key via a real runOperation whose completion always fails. */
async function wedgeKey(connectionId: string, key: string): Promise<void> {
  const provider = fakeProvider();
  const wedging = withWedgingCompletion(db);
  await runOperation(wedging, provider, 'send-message', sendInput(connectionId), key);
  const row = await db.idempotencyRecord.findUnique({ where: { key } });
  expect(row!.responseJson).toBeNull();
}

let spy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetDb(db);
  spy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  spy.mockRestore();
});

describe('listWedgedKeys — visibility without log scraping', () => {
  it('lists only NULL-response rows past the cutoff, oldest first', async () => {
    const old = new Date(Date.now() - 30 * 60_000);
    const fresh = new Date();
    await db.idempotencyRecord.createMany({
      data: [
        { key: 'k-old', operation: 'send-message', requestHash: 'a', responseJson: null, createdAt: old },
        { key: 'k-older', operation: 'edit-message', requestHash: 'b', responseJson: null, createdAt: new Date(old.getTime() - 60_000) },
        { key: 'k-fresh', operation: 'send-message', requestHash: 'c', responseJson: null, createdAt: fresh },
        { key: 'k-done', operation: 'send-message', requestHash: 'd', responseJson: '{"message":{}}', createdAt: old },
      ],
    });

    const rows = await listWedgedKeys(db, { olderThanMinutes: 15 });
    expect(rows.map((r) => r.key)).toEqual(['k-older', 'k-old']);
  });
});

describe('repairWedgedKey — complete mode', () => {
  it('dry-runs without confirmation: shows the row and the duplicate-send risk, changes nothing', async () => {
    const connectionId = await seedConnection();
    await wedgeKey(connectionId, 'k-dry');

    const outcome = await repairWedgedKey(db, 'k-dry', { mode: 'complete', confirm: false, minAgeMinutes: 0 });
    expect(outcome.status).toBe('dry-run');

    const row = await db.idempotencyRecord.findUnique({ where: { key: 'k-dry' } });
    expect(row!.responseJson).toBeNull();
  });

  it('dry-run plan for complete warns about the opposite failure: a fabricated success replays forever (BLIND F3)', async () => {
    await db.idempotencyRecord.create({
      data: { key: 'k-warn', operation: 'send-message', requestHash: 'a', responseJson: null, createdAt: new Date(Date.now() - 30 * 60_000) },
    });
    const outcome = await repairWedgedKey(db, 'k-warn', { mode: 'complete', confirm: false, minAgeMinutes: 0 });
    expect(outcome.status).toBe('dry-run');
    if (outcome.status === 'dry-run') {
      expect(outcome.plan).toMatch(/did NOT actually happen/i);
      expect(outcome.plan).toMatch(/never runs/i);
    }
  });

  it('resolves the wedge: same-key retries replay the repair marker, the provider is NOT called again', async () => {
    const connectionId = await seedConnection();
    await wedgeKey(connectionId, 'k-complete');
    const provider = fakeProvider();

    // The pre-repair state: the existing refusal still holds.
    await expect(
      runOperation(db, provider, 'send-message', sendInput(connectionId), 'k-complete'),
    ).rejects.toThrow(/still in flight/);

    const outcome = await repairWedgedKey(db, 'k-complete', { mode: 'complete', confirm: true, minAgeMinutes: 0 });
    expect(outcome.status).toBe('completed');

    const row = await db.idempotencyRecord.findUnique({ where: { key: 'k-complete' } });
    expect(row!.responseJson).not.toBeNull();
    const marker = JSON.parse(row!.responseJson!) as { repaired: boolean; operation: string };
    expect(marker.repaired).toBe(true);
    expect(marker.operation).toBe('send-message');

    // After the repair the key REPLAYS — the provider (a FRESH instance that
    // never saw the original send) is not called at all.
    const again = await runOperation(db, provider, 'send-message', sendInput(connectionId), 'k-complete');
    expect(again.replayed).toBe(true);
    expect((again.result as { repaired: boolean }).repaired).toBe(true);
    expect(provider.calls.filter(([m]) => m === 'sendMessage')).toHaveLength(0);
  });

  it('is guarded: completing an already-repaired key is refused, not rewritten', async () => {
    const connectionId = await seedConnection();
    await wedgeKey(connectionId, 'k-guard');
    const first = await repairWedgedKey(db, 'k-guard', { mode: 'complete', confirm: true, minAgeMinutes: 0 });
    expect(first.status).toBe('completed');

    const second = await repairWedgedKey(db, 'k-guard', { mode: 'complete', confirm: true, minAgeMinutes: 0 });
    expect(second.status).toBe('refused');
    expect(second.refusal).toBe('already-completed');
  });
});

describe('repairWedgedKey — clear mode', () => {
  it('deletes the reservation: the next same-key request re-executes the operation', async () => {
    const connectionId = await seedConnection();
    await wedgeKey(connectionId, 'k-clear');
    const provider = fakeProvider();

    // A mutating op under clear mode carries the duplicate-send risk flag.
    const dry = await repairWedgedKey(db, 'k-clear', { mode: 'clear', confirm: false, minAgeMinutes: 0 });
    expect(dry.status).toBe('dry-run');
    if (dry.status === 'dry-run') expect(dry.duplicateSendRisk).toBe(true);

    const outcome = await repairWedgedKey(db, 'k-clear', { mode: 'clear', confirm: true, minAgeMinutes: 0 });
    expect(outcome.status).toBe('cleared');
    expect(await db.idempotencyRecord.findUnique({ where: { key: 'k-clear' } })).toBeNull();

    const again = await runOperation(db, provider, 'send-message', sendInput(connectionId), 'k-clear');
    expect(again.replayed).toBe(false);
    // The fresh provider executes exactly one send — the re-execution.
    expect(provider.calls.filter(([m]) => m === 'sendMessage')).toHaveLength(1);
  });
});

describe('repairWedgedKey — interlocks', () => {
  it('refuses a row still young enough to be genuinely in flight', async () => {
    await db.idempotencyRecord.create({
      data: { key: 'k-young', operation: 'send-message', requestHash: 'a', responseJson: null },
    });
    const outcome = await repairWedgedKey(db, 'k-young', { mode: 'complete', confirm: true, minAgeMinutes: 15 });
    expect(outcome.status).toBe('refused');
    expect(outcome.refusal).toBe('too-young');
    expect(await db.idempotencyRecord.findUnique({ where: { key: 'k-young' } })).not.toBeNull();
  });

  it('refuses a completed key (nothing to repair) and an unknown key', async () => {
    await db.idempotencyRecord.create({
      data: { key: 'k-done', operation: 'send-message', requestHash: 'a', responseJson: '{"message":{}}' },
    });
    const done = await repairWedgedKey(db, 'k-done', { mode: 'complete', confirm: true, minAgeMinutes: 0 });
    expect(done.refusal).toBe('already-completed');

    const missing = await repairWedgedKey(db, 'k-nope', { mode: 'clear', confirm: true, minAgeMinutes: 0 });
    expect(missing.status).toBe('refused');
    expect(missing.refusal).toBe('not-found');
  });

  it('write guard: a completion landing between the read and the write wins, both modes (LOCAL F1)', async () => {
    // Complete mode: the concurrent completion must stand — no marker over it.
    await db.idempotencyRecord.create({
      data: { key: 'k-race-complete', operation: 'send-message', requestHash: 'a', responseJson: null, createdAt: new Date(Date.now() - 30 * 60_000) },
    });
    const completed = await repairWedgedKey(withCompletionBetweenReadAndWrite(db), 'k-race-complete', {
      mode: 'complete',
      confirm: true,
      minAgeMinutes: 0,
    });
    expect(completed.status).toBe('refused');
    expect(completed.refusal).toBe('already-completed');
    const afterComplete = await db.idempotencyRecord.findUnique({ where: { key: 'k-race-complete' } });
    expect(afterComplete!.responseJson).toBe('{"message":{"concurrentWinner":true}}');

    // Clear mode: the concurrent completion must survive — the row is NOT deleted.
    await db.idempotencyRecord.create({
      data: { key: 'k-race-clear', operation: 'send-message', requestHash: 'b', responseJson: null, createdAt: new Date(Date.now() - 30 * 60_000) },
    });
    const cleared = await repairWedgedKey(withCompletionBetweenReadAndWrite(db), 'k-race-clear', {
      mode: 'clear',
      confirm: true,
      minAgeMinutes: 0,
    });
    expect(cleared.status).toBe('refused');
    expect(cleared.refusal).toBe('already-completed');
    const afterClear = await db.idempotencyRecord.findUnique({ where: { key: 'k-race-clear' } });
    expect(afterClear!.responseJson).toBe('{"message":{"concurrentWinner":true}}');
  });

  it('row-identity pin: a key deleted and re-reserved between the read and the write is not clobbered, every retry shape, both modes (BLIND F1 + local-delta P2)', async () => {
    // Each shape leaves exactly ONE guard term separating the new live
    // reservation from the judged row, so dropping that term from the where
    // clause clobbers the reservation and this pin goes red:
    //  - same-payload retry (original requestHash, fresh createdAt) — the
    //    realistic same-key retry; only createdAt refuses the write,
    //  - same-createdAt (fresh requestHash, original createdAt) — only
    //    requestHash refuses the write,
    //  - both fresh — the different-payload retry; either term refuses it.
    const shapes = [
      { label: 'same-payload retry', requestHash: 'original', createdAt: 'fresh' },
      { label: 'same-createdAt', requestHash: 'fresh', createdAt: 'original' },
      { label: 'both fresh', requestHash: 'fresh', createdAt: 'fresh' },
    ] as const;

    for (const [i, shape] of shapes.entries()) {
      const suffix = `-${i}`;
      const seedAge = new Date(Date.now() - 30 * 60_000);

      // Complete mode: the fresh reservation must stay response-less — no marker over it.
      await db.idempotencyRecord.create({
        data: { key: `k-reres${suffix}-complete`, operation: 'send-message', requestHash: 'a', responseJson: null, createdAt: seedAge },
      });
      const completed = await repairWedgedKey(withResurrectionBetweenReadAndWrite(db, shape), `k-reres${suffix}-complete`, {
        mode: 'complete',
        confirm: true,
        minAgeMinutes: 0,
      });
      expect(completed.status, `${shape.label}: complete`).toBe('refused');
      // The row that now exists is a NEW live reservation, not a completion.
      expect(completed.refusal, `${shape.label}: complete refusal`).toBe('too-young');
      const afterComplete = await db.idempotencyRecord.findUnique({ where: { key: `k-reres${suffix}-complete` } });
      expect(afterComplete!.responseJson, `${shape.label}: no marker over the live reservation`).toBeNull();
      // …and it is the re-reservation, not the judged row.
      if (shape.createdAt === 'fresh') {
        expect(afterComplete!.createdAt.getTime(), `${shape.label}: complete row is the re-reservation`).toBeGreaterThan(seedAge.getTime());
      }
      if (shape.requestHash === 'fresh') {
        expect(afterComplete!.requestHash, `${shape.label}: complete row is the re-reservation`).toBe('re-reserved');
      }

      // Clear mode: the fresh reservation must survive the delete.
      await db.idempotencyRecord.create({
        data: { key: `k-reres${suffix}-clear`, operation: 'send-message', requestHash: 'b', responseJson: null, createdAt: seedAge },
      });
      const cleared = await repairWedgedKey(withResurrectionBetweenReadAndWrite(db, shape), `k-reres${suffix}-clear`, {
        mode: 'clear',
        confirm: true,
        minAgeMinutes: 0,
      });
      expect(cleared.status, `${shape.label}: clear`).toBe('refused');
      expect(cleared.refusal, `${shape.label}: clear refusal`).toBe('too-young');
      const afterClear = await db.idempotencyRecord.findUnique({ where: { key: `k-reres${suffix}-clear` } });
      expect(afterClear!.responseJson, `${shape.label}: the live reservation survived the delete`).toBeNull();
      if (shape.createdAt === 'fresh') {
        expect(afterClear!.createdAt.getTime(), `${shape.label}: clear row is the re-reservation`).toBeGreaterThan(seedAge.getTime());
      }
      if (shape.requestHash === 'fresh') {
        expect(afterClear!.requestHash, `${shape.label}: clear row is the re-reservation`).toBe('re-reserved');
      }
    }
  });
});
