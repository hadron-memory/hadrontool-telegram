/**
 * Poll-worker tests — the spec-042 delivery-semantics invariants the PR #591
 * reviews hardened:
 *
 *  1. the cursor advances ONLY after the forwarder confirms delivery,
 *  2. a failed forward leaves the cursor put (the batch re-fetches),
 *  3. a poison update is dead-lettered after bounded retries,
 *  4. skips (bot messages, non-message updates) advance without forwarding,
 *  5. /start DMs become telegram.start with the deep-link payload.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptToken } from '../crypto.js';
import { db } from '../db.js';
import type { TelegramEvent } from '../events/forwarder.js';
import { TelegramApiError } from '../providers/botapi/types.js';
import { botUser, fakeProvider, resetDb, tgMessage, updatesFrom } from '../test/fakes.js';
import { clearPollerState, drainOnce, eventForUpdate } from './poller.js';

/** Seed one ACTIVE connection; returns its id. */
async function seedConnection(): Promise<string> {
  const row = await db.connection.create({
    data: { botId: '7777', botUsername: 'hadron_test_bot', tokenEnc: encryptToken('raw-bot-token') },
  });
  return row.id;
}

/** A forwarder that records events and answers per a scripted plan. */
function recordingForwarder(plan: boolean[] = []) {
  const events: TelegramEvent[] = [];
  let i = 0;
  const forward = async (event: TelegramEvent) => {
    events.push(event);
    return plan[i++] ?? true;
  };
  return { events, forward };
}

async function cursorOf(connectionId: string): Promise<number> {
  const row = await db.connection.findUnique({ where: { id: connectionId } });
  return Number(row!.lastUpdateId);
}

beforeEach(async () => {
  await resetDb(db);
  clearPollerState();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('drainOnce', () => {
  it('forwards messages in order and advances the cursor per confirmed update', async () => {
    const provider = fakeProvider();
    provider.pending.push(
      ...updatesFrom(
        11,
        tgMessage({ message_id: 1, text: 'first' }),
        tgMessage({ message_id: 2, text: 'second' }),
      ),
    );
    const { events, forward } = recordingForwarder();
    const connectionId = await seedConnection();

    expect(await drainOnce(db, provider, forward, connectionId)).toBe('ok');
    expect(events.map((e) => (e as { text?: string }).text)).toEqual(['first', 'second']);
    expect(await cursorOf(connectionId)).toBe(12);
    // The next poll asks Telegram for offset cursor+1, confirming the batch.
    expect(await drainOnce(db, provider, forward, connectionId)).toBe('ok');
    const lastGetUpdates = provider.calls.filter(([m]) => m === 'getUpdates').at(-1)!;
    expect((lastGetUpdates[1] as unknown[])[1]).toBe(13);
  });

  it('does NOT advance the cursor when core delivery fails — the batch re-fetches', async () => {
    const provider = fakeProvider();
    provider.pending.push(...updatesFrom(21, tgMessage({ text: 'must not be lost' })));
    const { events, forward } = recordingForwarder([false, true]);
    const connectionId = await seedConnection();

    expect(await drainOnce(db, provider, forward, connectionId)).toBe('error');
    expect(await cursorOf(connectionId)).toBe(0);

    // Next cycle re-fetches the same update; this time core confirms.
    expect(await drainOnce(db, provider, forward, connectionId)).toBe('ok');
    expect(await cursorOf(connectionId)).toBe(21);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(events[1]);
  });

  it('stops a mid-batch failure from confirming later updates', async () => {
    const provider = fakeProvider();
    provider.pending.push(
      ...updatesFrom(31, tgMessage({ text: 'ok' }), tgMessage({ text: 'fails' }), tgMessage({ text: 'after' })),
    );
    const { events, forward } = recordingForwarder([true, false]);
    const connectionId = await seedConnection();

    expect(await drainOnce(db, provider, forward, connectionId)).toBe('error');
    // First update confirmed; the failed one and everything behind it retry.
    expect(await cursorOf(connectionId)).toBe(31);
    expect(events).toHaveLength(2);
  });

  it('dead-letters a poison update after bounded retries so the stream unwedges', async () => {
    const provider = fakeProvider();
    provider.pending.push(...updatesFrom(41, tgMessage({ text: 'poison' }), tgMessage({ text: 'healthy' })));
    // The poison event fails every time; 'healthy' succeeds when reached.
    const { events, forward } = recordingForwarder([false, false, false, false, false, true]);
    const connectionId = await seedConnection();

    for (let cycle = 0; cycle < 4; cycle++) {
      expect(await drainOnce(db, provider, forward, connectionId)).toBe('error');
      expect(await cursorOf(connectionId)).toBe(0);
    }
    // Fifth failed delivery hits the dead-letter bound: skip poison, deliver healthy.
    expect(await drainOnce(db, provider, forward, connectionId)).toBe('ok');
    expect(await cursorOf(connectionId)).toBe(42);
    expect(events.filter((e) => (e as { text?: string }).text === 'healthy')).toHaveLength(1);
  });

  it('skips bot-authored and non-message updates without forwarding, still advancing', async () => {
    const provider = fakeProvider();
    provider.pending.push(
      { update_id: 51, message: tgMessage({ from: { ...botUser(), id: 8888 }, text: 'from a bot' }) },
      { update_id: 52 }, // e.g. an edited_message update — no `message` field
      ...updatesFrom(53, tgMessage({ text: 'human' })),
    );
    const { events, forward } = recordingForwarder();
    const connectionId = await seedConnection();

    expect(await drainOnce(db, provider, forward, connectionId)).toBe('ok');
    expect(events).toHaveLength(1);
    expect((events[0] as { text?: string }).text).toBe('human');
    expect(await cursorOf(connectionId)).toBe(53);
  });

  it('stops when the connection is gone and marks ERROR on a dead token', async () => {
    const provider = fakeProvider({
      failWith: { methods: ['getUpdates'], error: new TelegramApiError(401, 'Unauthorized') },
    });
    const { forward } = recordingForwarder();
    const connectionId = await seedConnection();

    expect(await drainOnce(db, provider, forward, connectionId)).toBe('stopped');
    const row = await db.connection.findUnique({ where: { id: connectionId } });
    expect(row!.status).toBe('ERROR');

    await db.connection.update({ where: { id: connectionId }, data: { deletedAt: new Date() } });
    expect(await drainOnce(db, provider, forward, connectionId)).toBe('stopped');
  });
});

describe('eventForUpdate', () => {
  it('turns a /start DM into telegram.start with the deep-link payload', () => {
    const event = eventForUpdate('conn-1', {
      update_id: 1,
      message: tgMessage({ text: '/start hdr-link-abc123' }),
    });
    expect(event).toMatchObject({ event: 'telegram.start', payload: 'hdr-link-abc123', chatId: '555' });
  });

  it('a bare /start yields an empty payload; a group /start stays a plain message', () => {
    const bare = eventForUpdate('conn-1', { update_id: 1, message: tgMessage({ text: '/start' }) });
    expect(bare).toMatchObject({ event: 'telegram.start', payload: '' });

    const group = eventForUpdate('conn-1', {
      update_id: 2,
      message: tgMessage({ text: '/start x', chat: { id: -100123, type: 'supergroup', title: 'Team' } }),
    });
    expect(group).toMatchObject({ event: 'telegram.message.received', kind: 'group' });
  });

  it('classifies DMs vs groups and carries forum thread + reply ids', () => {
    const event = eventForUpdate('conn-1', {
      update_id: 3,
      message: tgMessage({
        chat: { id: -100123, type: 'supergroup', title: 'EngTeamChat', is_forum: true },
        message_thread_id: 7,
        reply_to_message: { message_id: 99 },
        text: '@rachael is Holger in tomorrow?',
      }),
    });
    expect(event).toMatchObject({
      event: 'telegram.message.received',
      kind: 'group',
      chatId: '-100123',
      messageThreadId: 7,
      replyToMessageId: 99,
    });
  });
});
