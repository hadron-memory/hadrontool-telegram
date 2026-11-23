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
import type { Db } from '../db.js';
import type { TgUpdate } from '../providers/botapi/types.js';
import type { TelegramProvider } from '../providers/botapi/types.js';
import { fakeProvider, resetDb, tgMessage, updatesFrom } from '../test/fakes.js';
import { claimPollLease, LEASE_MS, LEASE_RENEW_MS, renewPollLease, startPollWorker } from './poller.js';

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
  let started = 0;
  const provider: TelegramProvider = {
    ...base,
    async getUpdates(botToken, offset, timeoutS) {
      started += 1;
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
    /** Calls that ENTERED getUpdates — countable while still gated blocked. */
    getUpdatesStarted: () => started,
    maxInFlight: () => maxInFlight,
    /** Queue updates for the next (or in-flight, gate-blocked) fetch to see. */
    pendingUpdates: (updates: TgUpdate[]) => {
      base.pending.push(...updates);
    },
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
    await until(() => g.getUpdatesStarted() === 1, 'worker 1 starts its loop');

    const w2 = startPollWorker(db, g.provider, noopForward);
    workers.push(w2);
    await w2.reconcileNow();
    // Give a would-be second loop every chance to (wrongly) start.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(g.getUpdatesStarted()).toBe(1);
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
    await until(() => g.getUpdatesStarted() === 1, 'worker 1 starts its loop');

    const w2 = startPollWorker(db, g.provider, noopForward);
    workers.push(w2);
    await w2.reconcileNow();
    expect(g.getUpdatesStarted()).toBe(1); // lease held: no second loop

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
    await until(() => g.getUpdatesStarted() === 2, 'worker 2 takes over the expired lease');

    // THE invariant: at no moment were two getUpdates calls in flight.
    expect(g.maxInFlight()).toBe(1);
    // And the takeover stuck: worker 2 owns the lease now.
    const row = await db.connection.findFirst();
    expect(row!.pollLeaseOwner).toBeTruthy();
  });

  it('releasing on a stopped connection frees the lease for another worker', async () => {
    const g = gatedProvider();
    const connectionId = await seedConnection();

    g.block();
    const w1 = startPollWorker(db, g.provider, noopForward);
    workers.push(w1);
    await until(() => g.getUpdatesStarted() === 1, 'worker 1 starts its loop');

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

  it('overlapping reconciles in ONE process still start exactly one loop', async () => {
    const g = gatedProvider();
    await seedConnection();

    g.block();
    const w1 = startPollWorker(db, g.provider, noopForward);
    workers.push(w1);
    // The reconcile mutex must serialize these — without it, two reconciles
    // racing across the claim await both start loops for the connection.
    await Promise.all(Array.from({ length: 8 }, () => w1.reconcileNow()));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(g.getUpdatesStarted()).toBe(1);
    expect(g.maxInFlight()).toBe(1);
  });

  it('a lease claim that throws fails that connection only — the reconciler survives', async () => {
    await seedConnection();
    let threw = false;
    const flakyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'connection') return Reflect.get(target, prop, receiver);
        return new Proxy(target.connection, {
          get(t, p, r) {
            if (p === 'updateMany' && !threw) {
              threw = true;
              return () => Promise.reject(new Error('db down'));
            }
            return Reflect.get(t, p, r);
          },
        });
      },
    }) as typeof db;
    const g = gatedProvider();
    const w1 = startPollWorker(flakyDb, g.provider, noopForward);
    workers.push(w1);
    await expect(w1.reconcileNow()).resolves.toBeUndefined();
    expect(g.getUpdatesStarted()).toBe(0);
  });
});

describe('lease renewal (F3 — the review delta)', () => {
  it("renew never steals another instance's live lease", async () => {
    const connectionId = await seedConnection();
    expect(await claimPollLease(db, connectionId, 'instance-b', 60_000)).toBe(true);
    const before = await db.connection.findUnique({ where: { id: connectionId } });

    expect(await renewPollLease(db, connectionId, 'instance-a', 60_000)).toBe(false);

    const row = await db.connection.findUnique({ where: { id: connectionId } });
    expect(row!.pollLeaseOwner).toBe('instance-b');
    expect(row!.pollLeaseExpiresAt!.getTime()).toBe(before!.pollLeaseExpiresAt!.getTime());
  });

  it('a renewal that finds the lease taken from us stops the loop — no steal-back', async () => {
    const g = gatedProvider();
    await seedConnection();

    g.block();
    const w1 = startPollWorker(db, g.provider, noopForward, { leaseMs: 10_000, renewMs: 50 });
    workers.push(w1);
    await until(() => g.getUpdatesStarted() === 1, 'worker 1 starts its loop');

    // Another instance takes the lease over underneath us (owner rewritten).
    await db.connection.updateMany({
      data: { pollLeaseOwner: 'other-instance', pollLeaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    // Let at least one renew tick fire (<=50 ms cadence) while the loop is
    // held inside its in-flight getUpdates.
    await new Promise((resolve) => setTimeout(resolve, 150));

    g.unblock();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settled = g.getUpdatesStarted();
    // The loop exits on the lost lease instead of cycling again.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(g.getUpdatesStarted()).toBe(settled);
    expect(g.maxInFlight()).toBe(1);
    // And the takeover was NOT stolen back.
    const row = await db.connection.findFirst();
    expect(row!.pollLeaseOwner).toBe('other-instance');
  });

  it('the renewal cadence keeps the lease expiry moving while the loop runs', async () => {
    const g = gatedProvider();
    await seedConnection();

    g.block();
    const w1 = startPollWorker(db, g.provider, noopForward, { leaseMs: 5_000, renewMs: 50 });
    workers.push(w1);
    await until(() => g.getUpdatesStarted() === 1, 'worker 1 starts its loop');
    const first = await db.connection.findFirst();
    const firstExpiry = first!.pollLeaseExpiresAt!.getTime();

    const deadline = Date.now() + 2_000;
    for (;;) {
      const row = await db.connection.findFirst();
      if (row!.pollLeaseExpiresAt!.getTime() > firstExpiry) break;
      if (Date.now() > deadline) throw new Error('lease expiry never advanced — renewal is not running at its cadence');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });

  it('production lease timing: the renewal cadence leaves at least two renewals inside the lease window', () => {
    expect(LEASE_RENEW_MS * 2).toBeLessThanOrEqual(LEASE_MS);
  });

  it('a row with an owner but a NULL expiry is claimable (corrupt state never wedges the loop)', async () => {
    const connectionId = await seedConnection();
    await db.connection.update({
      where: { id: connectionId },
      data: { pollLeaseOwner: 'ghost', pollLeaseExpiresAt: null },
    });
    expect(await claimPollLease(db, connectionId, 'instance-a')).toBe(true);
    const row = await db.connection.findUnique({ where: { id: connectionId } });
    expect(row!.pollLeaseOwner).toBe('instance-a');
  });

  it('the fenced cursor write: a stale owner confirms nothing and stops', async () => {
    const g = gatedProvider();
    const connectionId = await seedConnection();

    g.block();
    const w1 = startPollWorker(db, g.provider, noopForward, { leaseMs: 10_000, renewMs: 5_000 });
    workers.push(w1);
    await until(() => g.getUpdatesStarted() === 1, 'worker 1 starts its loop');

    // Queue an update, then hand the lease to another instance before the
    // blocked fetch returns.
    g.pendingUpdates(updatesFrom(500, tgMessage({ message_id: 500, text: 'hello' })));
    await db.connection.updateMany({
      data: { pollLeaseOwner: 'other-instance', pollLeaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    g.unblock();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The batch was fetched, but the cursor write is fenced on ownership:
    // the update stays UNCONFIRMED for the survivor to re-fetch.
    const row = await db.connection.findUnique({ where: { id: connectionId } });
    expect(row!.lastUpdateId).toBe(0n);
    expect(g.maxInFlight()).toBe(1);
  });
});
