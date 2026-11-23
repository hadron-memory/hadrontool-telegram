/**
 * Ops repair path for a wedged idempotency key (#11, deferred from #10
 * BLIND F7).
 *
 * A key wedges when `completeIdempotencyRecord` keeps failing after the
 * provider mutation SUCCEEDED — the response must stand (throwing would make
 * the caller re-send), so the record stays `responseJson: null` and every
 * future same-key retry is refused ("still in flight"). A process crash
 * around the reservation, or a failed reservation-release on the op-failure
 * path, wedges the same way without the log line.
 *
 * This module is the operator's resolution, never an automatic one: a TTL or
 * auto-repair would have to GUESS whether the provider mutation happened, and
 * guessing wrong either duplicates a send or replays a fabricated response.
 * The CLI (src/ops/repair-cli.ts) is the human-confirmation gate; everything
 * here is explicit and guarded:
 *
 *  - 'complete' writes a repair marker as the stored response. Same-key
 *    retries then REPLAY the marker (not the lost real response — that is
 *    gone) instead of being refused. No re-send. For the "the tool log shows
 *    `idempotency completion failed`" case, where the mutation DID happen.
 *  - 'clear' deletes the reservation. The next same-key request RE-EXECUTES
 *    the operation — the right semantics when the mutation did NOT happen
 *    (op failed, or crashed before the provider call), and a duplicate send
 *    when it did. The dry run names that risk; the confirmation owns it.
 *
 * Both writes are guarded (`… where responseJson: null` plus the read row's
 * requestHash and createdAt) so a repair can never clobber a completion that
 * landed concurrently, nor a fresh reservation that replaced the judged row
 * under the same key.
 */
import type { Db } from '../db.js';
import { OPERATIONS } from './index.js';

/** Past this age a NULL-response row is wedged, not in flight. */
export const DEFAULT_WEDGED_MIN_AGE_MINUTES = 15;

/** listWedgedKeys never scans unboundedly. */
export const DEFAULT_LIST_LIMIT = 50;

export type RepairMode = 'complete' | 'clear';

/** The operator-facing projection of an idempotency record. */
export interface WedgedKeyView {
  key: string;
  operation: string;
  requestHash: string;
  responseJson: string | null;
  createdAt: Date;
}

export type RepairRefusal = 'not-found' | 'already-completed' | 'too-young';

export interface RepairOptions {
  mode: RepairMode;
  /** The human-confirmation gate: false yields a dry run that writes nothing. */
  confirm: boolean;
  /** Rows younger than this are treated as possibly in flight. */
  minAgeMinutes?: number;
  now?: Date;
}

export type RepairOutcome =
  | {
      status: 'dry-run';
      mode: RepairMode;
      row: WedgedKeyView;
      /** True when the mode can duplicate a provider mutation (clear + mutating op). */
      duplicateSendRisk: boolean;
      plan: string;
    }
  | { status: 'completed'; row: WedgedKeyView }
  | { status: 'cleared'; row: WedgedKeyView }
  | { status: 'refused'; refusal: RepairRefusal; row?: WedgedKeyView };

const REPAIR_NOTE =
  'completion write failed after the provider mutation succeeded; the original response was lost — this marker un-wedges the key';

/** The response a 'complete' repair stores; same-key retries replay it. */
export function repairedResponseMarker(operation: string, repairedAt: Date): string {
  return JSON.stringify({ repaired: true, repairedAt: repairedAt.toISOString(), operation, note: REPAIR_NOTE });
}

function view(row: { key: string; operation: string; requestHash: string; responseJson: string | null; createdAt: Date }): WedgedKeyView {
  return {
    key: row.key,
    operation: row.operation,
    requestHash: row.requestHash,
    responseJson: row.responseJson,
    createdAt: row.createdAt,
  };
}

/** Find wedged keys (NULL response, older than the cutoff) without log scraping. */
export async function listWedgedKeys(
  db: Db,
  opts: { olderThanMinutes?: number; limit?: number; now?: Date } = {},
): Promise<WedgedKeyView[]> {
  const { olderThanMinutes = DEFAULT_WEDGED_MIN_AGE_MINUTES, limit = DEFAULT_LIST_LIMIT, now = new Date() } = opts;
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);
  const rows = await db.idempotencyRecord.findMany({
    where: { responseJson: null, createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  return rows.map(view);
}

/** Resolve one wedged key under explicit confirmation; see the module comment. */
export async function repairWedgedKey(db: Db, key: string, opts: RepairOptions): Promise<RepairOutcome> {
  const now = opts.now ?? new Date();
  const row = await db.idempotencyRecord.findUnique({ where: { key } });
  if (!row) return { status: 'refused', refusal: 'not-found' };
  if (row.responseJson != null) return { status: 'refused', refusal: 'already-completed', row: view(row) };

  const minAgeMinutes = opts.minAgeMinutes ?? DEFAULT_WEDGED_MIN_AGE_MINUTES;
  if (now.getTime() - row.createdAt.getTime() < minAgeMinutes * 60_000) {
    return { status: 'refused', refusal: 'too-young', row: view(row) };
  }

  // Unknown operation names repair as mutating: fail toward the louder warning.
  const mutating = OPERATIONS[row.operation]?.mutating ?? true;

  if (!opts.confirm) {
    return {
      status: 'dry-run',
      mode: opts.mode,
      row: view(row),
      duplicateSendRisk: opts.mode === 'clear' && mutating,
      plan:
        opts.mode === 'complete'
          ? 'write a repair marker as the stored response; same-key retries replay it (no re-send). Opposite-failure risk: if the provider mutation did NOT actually happen, every future same-key retry replays a fabricated success and the operation never runs — confirm the completion-failed log line first'
          : 'delete the reservation; the next same-key request re-executes the operation',
    };
  }

  if (opts.mode === 'complete') {
    // The where clause pins the EXACT row that was read (requestHash +
    // createdAt) and that it still holds no response. {key, responseJson:
    // null} alone would also match a row deleted and re-reserved under the
    // same key between the read and this write — writing the marker over a
    // live reservation (BLIND F1).
    const res = await db.idempotencyRecord.updateMany({
      where: { key, responseJson: null, requestHash: row.requestHash, createdAt: row.createdAt },
      data: { responseJson: repairedResponseMarker(row.operation, now) },
    });
    if (res.count === 0) return await reReadAfterGuardMiss(db, key);
    return { status: 'completed', row: view(row) };
  }

  const res = await db.idempotencyRecord.deleteMany({
    where: { key, responseJson: null, requestHash: row.requestHash, createdAt: row.createdAt },
  });
  if (res.count === 0) return await reReadAfterGuardMiss(db, key);
  return { status: 'cleared', row: view(row) };
}

/**
 * A guarded write that matched nothing: the row completed, vanished, or was
 * replaced between the read and the write. A re-read row that still holds no
 * response is NOT a completion — it is a fresh reservation replacing the one
 * this repair judged, so it is reported as possibly in flight.
 */
async function reReadAfterGuardMiss(db: Db, key: string): Promise<RepairOutcome> {
  const again = await db.idempotencyRecord.findUnique({ where: { key } });
  if (!again) return { status: 'refused', refusal: 'not-found' };
  if (again.responseJson == null) return { status: 'refused', refusal: 'too-young', row: view(again) };
  return { status: 'refused', refusal: 'already-completed', row: view(again) };
}
