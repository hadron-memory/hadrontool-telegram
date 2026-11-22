# hadrontool-telegram

Telegram tool for the Hadron platform — a standalone capability tool that
**owns the Telegram Bot API provider relationship**: bot tokens, message
operations, and update polling. It exposes a **provider-neutral** operations
surface over HTTP; `hadron-server` stays the front door (identity,
authorization, bindings, the chat bridge) and calls this service with
already-authorized requests.

The tool is **Hadron-blind** (spec 042 decision 6): no core tables, no core
API. Tool→core is the normalized events ingress only; core→tool is `/ops/*`
only. When an op needs Hadron context, core passes it in the request.

Design + decision record: `hadron-server/specs/042-telegram-integration/plan.md`
and `hrn:node:hadronmemory.com:hadron-server:reference:hadrontool-telegram`.
Tracking: hadron-server#592. Pattern precedent: hadrontool-ms-exchange (#396).

## Surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/ops/<operation>` | Provider-neutral message operations (spec 042 names) |
| `POST` | `/connections` | Register a bot (`{botToken, registrationKey?}` — validated live via getMe). `registrationKey` is optional, opaque, 16-128 chars: a retry with the key that created an active registration returns it (200, same body as the 201); any other second registration for the bot is refused (400, naming no connection id). The key is never logged or echoed (only its SHA-256 is stored) |
| `GET` | `/connections/:id` | Connection identity + poll state |
| `DELETE` | `/connections/:id` | Soft-delete (polling stops itself) |
| `GET` | `/info` | Capabilities (operation + event list) |
| `GET` | `/healthz` / `/readyz` | Liveness / readiness (readiness checks the DB) |

All routes require `Authorization: Bearer $TELEGRAM_TOOL_TOKEN`; in
production the service refuses to start without it. **There is no public
route** — v1 polls `getUpdates`, so unlike hadrontool-ms-exchange nothing
needs Traefik/DNS exposure.

### Operations (v1)

`send-message`, `edit-message`, `delete-message`, `get-chat`,
`get-chat-member`, `get-me`.

Request body: the operation input (always includes `connectionId`) plus an
optional `idempotencyKey` on mutating operations — a replayed key returns
the stored response without touching Telegram. **Send operations are
synchronous**: a 2xx means Telegram confirmed delivery; the tool paces
per-chat (~1 msg/s) and absorbs short waits inline, but on saturation
returns `provider_rate_limited` + `retryAfterSeconds` — durable retry
belongs to the caller (core's sweep worker), which replays with the same
idempotency key. Errors use the typed catalog (`connection_not_found`,
`connection_unauthorized`, `chat_forbidden`, `provider_rate_limited`,
`not_found`, `validation_error`, …) as `{ "error": "<code>", … }`.

```bash
curl -sS -X POST http://hadrontool-telegram:8080/ops/send-message \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TELEGRAM_TOOL_TOKEN" \
  -d '{"connectionId":"…","chatId":"555","text":"inbox summary ready"}'
```

### Events (tool → core)

One `getUpdates` long-poll loop per active connection turns updates into
normalized events — `telegram.message.received` (DM or group, with forum
`messageThreadId` and reply mapping) and `telegram.start` (the deep-link
binding redemption) — POSTed to `CORE_EVENTS_URL` with `CORE_EVENTS_TOKEN`.

**Delivery semantics** (the spec-042 invariant): advancing the poll cursor
confirms updates to Telegram, which deletes them server-side — so the cursor
advances only after core answers 2xx. A failed delivery re-fetches next
cycle (Telegram's 24h server-side queue is the durable buffer); a poison
update is dead-lettered after 5 attempts so it can't wedge the stream.
`CORE_EVENTS_URL` unset ⇒ events are logged + dropped *and the cursor still
advances* — an unconfigured consumer is deliberate, not an outage.

## Security

- **Bearer token** gate on every route; required in production.
- **Bot tokens** are AES-256-GCM-encrypted at rest under this tool's own
  `TOKEN_ENCRYPTION_KEY` (never core's key) and appear in no response, log
  line, or event.
- **No authorization logic here**: hadron-server authorizes every request
  *before* calling this tool — the tool never re-implements grants, and it
  cannot reach Hadron data at all.

## Development

```bash
npm install
cp .env.example .env           # fill in what you need; see comments
createdb hadrontool_telegram && npm run db:push
npm run dev                    # tsx watch on src/index.ts

npm test                       # vitest — requires the test DB once:
createdb hadrontool_telegram_test && npm run db:test-setup
```

Tests run the real HTTP surface + real Postgres over a fake Bot API — no
Telegram credentials needed.

## Configuration

See [.env.example](.env.example). Key vars: `TELEGRAM_TOOL_TOKEN`,
`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `CORE_EVENTS_URL` /
`CORE_EVENTS_TOKEN`, `TELEGRAM_POLL_TIMEOUT_S`, `TELEGRAM_SEND_GAP_MS`,
`DISABLE_POLL_WORKER`, `TELEGRAM_API_BASE`.
