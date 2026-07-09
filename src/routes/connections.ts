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
});

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
      // competing getUpdates poller, which Telegram rejects with 409s.
      const existing = await db.connection.findFirst({
        where: { botId: String(me.id), deletedAt: null },
      });
      if (existing) {
        throw new ValidationError('botToken', `a connection for @${me.username} already exists (${existing.id})`);
      }

      const connection = await db.connection.create({
        data: {
          botId: String(me.id),
          botUsername: me.username,
          displayName: [me.first_name, me.last_name].filter(Boolean).join(' ') || null,
          canReadAllGroupMessages: me.can_read_all_group_messages ?? false,
          tokenEnc: encryptToken(input.botToken),
        },
      });
      logInfo(`connection created for @${connection.botUsername} (${connection.id})`);
      res.status(201).json({
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
