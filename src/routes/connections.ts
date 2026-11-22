/**
 * Connection lifecycle — internal plane (bearer-gated).
 *
 * Registration is the whole "OAuth" story for Telegram: the App owner
 * created the bot in BotFather and holds its token; core forwards
 * `{botToken}` here already-authorized. The tool validates the token live
 * against getMe, derives the bot identity, stores the token encrypted under
 * its own key, and returns the identity. Core stores only that identity —
 * the token never appears in any response or log.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { encryptToken } from '../crypto.js';
import type { Db } from '../db.js';
import { ConnectionNotFoundError, ValidationError, mapTelegramError } from '../errors.js';
import { logInfo } from '../logger.js';
import { TelegramApiError, type TelegramProvider } from '../providers/botapi/types.js';
import { respondWithError } from './respond.js';

const createSchema = z.object({
  botToken: z.string().min(1),
  /**
   * Opaque idempotency key (16-128 chars), derived by the caller from its own
   * identity. A retry that reproduces it adopts the registration it created.
   */
  registrationKey: z
    .string()
    .min(16)
    .max(128)
    // A lone surrogate hashes (as UTF-8) to the same bytes as U+FFFD, so two
    // distinct accepted keys could collide: refuse ill-formed Unicode.
    .refine((k) => !/\p{Surrogate}/u.test(k), 'must be well-formed text')
    .optional(),
});

/** Digest stored for a key: the key itself is never persisted. */
function keyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Constant-time digest equality; a NULL stored digest (legacy row) never matches. */
function sameKey(stored: string | null, supplied: string | undefined): boolean {
  if (!stored || supplied === undefined) return false;
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(keyDigest(supplied), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Build the /connections router over injected db + provider. */
export function connectionsRouter(db: Db, provider: TelegramProvider): Router {
  const router = Router();

  // Register a bot: validate the token via getMe, encrypt, store.
  router.post('/', async (req, res) => {
    try {
      const input = createSchema.parse(req.body ?? {});

      let me;
      try {
        me = await provider.getMe(input.botToken);
      } catch (err) {
        // At registration a dead token is a CALLER input problem, not a
        // connection-state problem — connection_unauthorized would be
        // misleading before a connection exists.
        if (err instanceof TelegramApiError && (err.status === 401 || err.status === 404)) {
          throw new ValidationError('botToken', 'Telegram rejected the token (check the BotFather value)');
        }
        throw mapTelegramError(err);
      }
      if (!me.is_bot || !me.username) {
        throw new ValidationError('botToken', 'the token does not belong to a bot account');
      }

      // One active connection per bot: a second registration would start a
      // competing getUpdates poller, which Telegram rejects with 409s. The
      // check and the insert run under a per-bot advisory lock so concurrent
      // retries of one registration converge on one row.
      const botId = String(me.id);
      const outcome = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'telegram-register:' + botId}))`;
        const existing = await tx.connection.findFirst({ where: { botId, deletedAt: null } });
        if (existing) {
          // Adopted only by the caller that proves it created the row: the stored
          // digest equals the supplied key's. A different key, a legacy NULL-key
          // row and a keyless caller all keep the 400 — which never names the
          // other holder's connection id.
          if (sameKey(existing.registrationKeyHash, input.registrationKey)) {
            return { created: false as const, connection: existing };
          }
          throw new ValidationError('botToken', `a connection for @${me.username} already exists`);
        }
        const connection = await tx.connection.create({
          data: {
            botId,
            botUsername: me.username!,
            displayName: [me.first_name, me.last_name].filter(Boolean).join(' ') || null,
            canReadAllGroupMessages: me.can_read_all_group_messages ?? false,
            tokenEnc: encryptToken(input.botToken),
            registrationKeyHash: input.registrationKey === undefined ? null : keyDigest(input.registrationKey),
          },
        });
        return { created: true as const, connection };
      });
      const { connection } = outcome;
      if (outcome.created) {
        logInfo(`connection created for @${connection.botUsername} (${connection.id})`);
      } else {
        logInfo(`connection adopted for @${connection.botUsername} (${connection.id})`);
      }
      res.status(outcome.created ? 201 : 200).json({
        id: connection.id,
        provider: connection.provider,
        botId: connection.botId,
        botUsername: connection.botUsername,
        displayName: connection.displayName,
        canReadAllGroupMessages: connection.canReadAllGroupMessages,
        status: connection.status,
      });
    } catch (err) {
      respondWithError(res, err, 'create connection');
    }
  });

  // Connection identity + poll state.
  router.get('/:id', async (req, res) => {
    try {
      const connection = await db.connection.findUnique({ where: { id: req.params.id } });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();
      res.json({
        id: connection.id,
        provider: connection.provider,
        botId: connection.botId,
        botUsername: connection.botUsername,
        displayName: connection.displayName,
        canReadAllGroupMessages: connection.canReadAllGroupMessages,
        status: connection.status,
        lastError: connection.lastError,
        pollingEnabled: connection.pollingEnabled,
        lastUpdateId: Number(connection.lastUpdateId),
      });
    } catch (err) {
      respondWithError(res, err, 'get connection');
    }
  });

  // Disconnect: soft-delete; the poll loop stops itself on its next cycle.
  router.delete('/:id', async (req, res) => {
    try {
      const connection = await db.connection.findUnique({ where: { id: req.params.id } });
      if (!connection || connection.deletedAt) throw new ConnectionNotFoundError();
      await db.connection.update({ where: { id: connection.id }, data: { deletedAt: new Date() } });
      res.json({ deleted: true });
    } catch (err) {
      respondWithError(res, err, 'delete connection');
    }
  });

  return router;
}
