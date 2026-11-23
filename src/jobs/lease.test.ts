/**
 * Single-poll-loop lease tests (#1 F3): the process-local `running` guard
 * cannot stop two service instances (scale-out, overlapping rolling deploy)
 * from running competing getUpdates loops per connection — Telegram answers
 * the second long poll with a 409. The fix is a DB lease per connection
 * (pollLeaseOwner/pollLeaseExpiresAt): a reconciler may start a loop only
 * after claiming the lease, the loop renews it, and an expired lease is
 * claimable by a surviving instance.
 *
 * The invariant pinned here: across two workers sharing ONE database, at
 * most one getUpdates call per connection is ever in flight, and after the
 * holder dies the lease converges to the survivor.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptToken } from '../crypto.js';
import { db } from '../db.js';
import type { TelegramProvider } from '../providers/botapi/types.js';
import { fakeProvider, resetDb } from '../test/fakes.js';
import { startPollWorker } from './poller.js';

/** Seed one ACTIVE, polling connection; returns its id. */
async function seedConnection(): Promise<string> {
  const row = await db.connection.create({
    data: { botId: '7777', botUsername: 'hadron_test_bot', tokenEnc: encryptToken('raw-bot-token') },
  });
  return row.id;
}

/**
 * A provider whose getUpdates blocks on a gate we control — the stand-in for
 * Telegram's long poll. Tracks how many calls are in flight at once so the
 * no-double-loop invariant is assertable, not just inferable from call counts.
 */
function gatedProvider() {
  const base = fakeProvider();
  let release: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  let inFlight = 0;
  let maxInFlight = 0;
  const provider: TelegramProvider = {
    ...base,
    async getUpdates(botToken, offset, timeoutS) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await gate;
        return await base.getUpdates(botToken, offset, timeoutS);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return {
    provider,
    getUpdatesCalls: () => base.calls.filter(([m]) => m === 'getUpdates').length,
    maxInFlight: () => maxInFlight,
    block: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    unblock: () => {
      release();
    },
  };
}

/** Poll every 10ms until cond() holds or the timeout fails the test. */
async function until(cond: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const noopForward = async () => true;
let workers: { stop: () => void; reconcileNow: () => Promise<void> }[] = [];

beforeEach(async () => {
  await resetDb(db);
  workers = [];
});

afterEach(() => {
  for (const w of workers) w.stop();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('single poll loop per connection across workers (F3)', () => {
  it('a second worker sharing the database starts no competing loop', async () => {
    const g = gatedProvider();
    const connectionId = await seedConnection();

    g.block();
    const w1 = startPollWorker(db, g.provider, noopForward);
    workers.push(w1);
    await until(() => g.getUpdatesCalls() === 1, 'worker 1 starts its loop');

    const w2 = startPollWorker(db, g.provider, noopForward);
    workers.push(w2);
    await w2.reconcileNow();
    // Give a would-be second loop every chance to (wrongly) start.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(g.getUpdatesCalls()).toBe(1);
    // And the lease row names worker 1's instance as the owner.
    const row = await db.connection.findUnique({ where: { id: connectionId } });
    expect(row!.pollLeaseOwner).toBeTruthy();
    expect(row!.pollLeaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('converges on the survivor after the holder dies — never two concurrent loops', async () => {
    const g = gatedProvider();
    await seedConnection();

    g.block();
    const w1 = startPollWorker(db, g.provider, noopForward);
    workers.push(w1);
    await until(() => g.getUpdatesCalls() === 1, 'worker 1 starts its loop');

    const w2 = startPollWorker(db, g.provider, noopForward);
    workers.push(w2);
    await w2.reconcileNow();
    expect(g.getUpdatesCalls()).toBe(1); // lease held: no second loop

    // Simulate worker 1's process dying mid-long-poll: its stop flag is set
    // (the loop exits on its next cycle), and time moves past its lease.
    w1.stop();
    await db.connection.updateMany({
      data: { pollLeaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    // Worker 1's in-flight call completes; its loop then exits on the stop
    // flag without releasing the (already expired) lease.
    g.unblock();
    await new Promise((resolve) => setTimeout(resolve, 100));

    g.block(); // worker 2's loop will hang in its own long poll
    await w2.reconcileNow();
    await until(() => g.getUpdatesCalls() === 2, 'worker 2 takes over the expired lease');

    // THE invariant: at no moment were two getUpdates calls in flight.
    expect(g.maxInFlight()).toBe(1);
  });

  it('releasing on a stopped connection frees the lease for another worker', async () => {
    const g = gatedProvider();
    const connectionId = await seedConnection();

    g.block();
    const w1 = startPollWorker(db, g.provider, noopForward);
    workers.push(w1);
    await until(() => g.getUpdatesCalls() === 1, 'worker 1 starts its loop');

    // Disable polling: the current cycle finishes, the next drainOnce sees
    // 'stopped', and the loop must RELEASE the lease rather than leave it to
    // expire on its own.
    await db.connection.update({ where: { id: connectionId }, data: { pollingEnabled: false } });
    g.unblock();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const row = await db.connection.findUnique({ where: { id: connectionId } });
    expect(row!.pollLeaseOwner).toBeNull();
    expect(row!.pollLeaseExpiresAt).toBeNull();
    expect(g.maxInFlight()).toBe(1);
  });
});
