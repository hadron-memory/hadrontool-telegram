# Agent dev guide — hadrontool-telegram

Standalone Hadron capability tool for Telegram (Bot API). Third application
of the capability-tool pattern (pdf → ms-exchange → telegram); when in doubt,
mirror hadrontool-ms-exchange — the two repos deliberately share structure,
posture, and idioms.

## The three load-bearing invariants

1. **Hadron-blind** (spec 042 decision 6): this tool never touches core's
   tables or API. Tool→core = the events forwarder only; core→tool =
   `/ops/*` only. When an op needs Hadron context, core passes it in the
   request — *invert, don't query*.
2. **Cursor advance = confirmation** (src/jobs/poller.ts): calling
   getUpdates with a higher offset makes Telegram DELETE the updates below
   it. `Connection.lastUpdateId` therefore only advances after the
   forwarder returns true (core 2xx / deliberate skip / dead-letter). Never
   "log and continue" a failed forward.
3. **Never ack an undelivered send** (src/ops + src/pacing.ts): send ops are
   synchronous; the pacer absorbs ≤5s inline and otherwise returns
   provider_rate_limited — durable retry is core's job, keyed by
   idempotencyKey.

## Commands

```bash
npm run dev            # tsx watch (needs .env; createdb hadrontool_telegram + npm run db:push once)
npm test               # vitest vs hadrontool_telegram_test (createdb + npm run db:test-setup once)
npm run typecheck      # prisma generate + tsc --noEmit
```

Tests run the real Express app + real Postgres over the fake provider in
`src/test/fakes.ts` — no Telegram credentials, no network.

## Where things live

- Spec/plan: `hadron-server/specs/042-telegram-integration/plan.md`; decision
  node `hadronmemory.com::hadron-server::reference:hadrontool-telegram`;
  tracking hadron-server#592.
- Error codes are a PUBLIC contract (core's telegramClient passes them
  through verbatim) — add codes, never change meanings (src/errors.ts).
- The normalized message shape is shared by the ops responses AND the event
  plane (`normalizeMessage` in src/ops/index.ts) — keep them one type.
