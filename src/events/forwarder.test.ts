/**
 * Forwarder delivery-contract pins (#1 F1 context): the deliberate drop-mode.
 * vitest.config.ts's env block pins CORE_EVENTS_URL unset for the suite; the
 * first test below asserts that pin, so a later config change fails loudly
 * here instead of silently repointing these tests at a configured forwarder.
 * What is pinned: with no core consumer configured, a forwarded event is
 * logged + dropped BY CHOICE and the forwarder answers `true` — which is
 * what lets the poll worker advance the getUpdates cursor in dev/test.
 * F1's guard means this mode can no longer occur in production with the
 * poll worker on; nothing about the mode itself changes.
 */
import { config } from '../config.js';
import { describe, expect, it } from 'vitest';
import { forwardEventToCore } from './forwarder.js';
import type { TelegramEvent } from './forwarder.js';

const dmEvent: TelegramEvent = {
  event: 'telegram.message.received',
  connectionId: 'conn_1',
  chatId: '555',
  messageThreadId: null,
  kind: 'dm',
  from: { telegramUserId: '555', username: 'raghvind', displayName: 'Raghvind', isBot: false },
  messageId: 100,
  replyToMessageId: null,
  text: 'hello there',
  receivedAt: new Date(0).toISOString(),
};

describe('forwardEventToCore with CORE_EVENTS_URL unset (drop mode)', () => {
  it('suite precondition: the test env really has no core consumer configured', () => {
    expect(config.coreEventsUrl, 'vitest.config.ts must keep CORE_EVENTS_URL unset for this file').toBeUndefined();
  });

  it('answers true — the deliberate skip that lets the cursor advance', async () => {
    await expect(forwardEventToCore(dmEvent)).resolves.toBe(true);
  });

  it('answers true for the start event too (the deep-link redemption path)', async () => {
    const startEvent: TelegramEvent = {
      event: 'telegram.start',
      connectionId: 'conn_1',
      chatId: '555',
      from: { telegramUserId: '555', username: 'raghvind', displayName: 'Raghvind', isBot: false },
      payload: 'bind-abc',
    };
    await expect(forwardEventToCore(startEvent)).resolves.toBe(true);
  });
});
