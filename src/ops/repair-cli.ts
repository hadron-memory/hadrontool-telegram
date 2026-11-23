/**
 * Ops CLI for the wedged-idempotency-key repair path (#11).
 *
 * Run by the operator against the tool's own DATABASE_URL — locally with
 * `npm run tsx src/ops/repair-cli.ts …`, or inside the deployed container
 * (Komodo exec, same Doppler injection as the server):
 *
 *   doppler run -- node dist/ops/repair-cli.js --list
 *   doppler run -- node dist/ops/repair-cli.js --key <key> --complete
 *   doppler run -- node dist/ops/repair-cli.js --key <key> --clear
 *
 * Every mutating invocation is a DRY RUN until --yes is passed: that flag is
 * the human-confirmation gate. Exit codes: 0 list/dry-run/executed, 2 usage,
 * 4 refused (nothing written).
 *
 * Choosing a mode (the row's circumstances decide, the log confirms):
 *  - the tool log shows `idempotency completion failed for key <key>` → the
 *    provider mutation SUCCEEDED and the response is lost → --complete
 *    (retries replay a marker; no re-send);
 *  - no such line (crash around the reservation, or a failed release after
 *    an op failure) → --clear (the next same-key request re-executes the
 *    operation — a duplicate send IF the mutation did happen: check first).
 */
import { db } from '../db.js';
import { DEFAULT_LIST_LIMIT, DEFAULT_WEDGED_MIN_AGE_MINUTES, listWedgedKeys, repairWedgedKey } from './repair.js';

/** The CLI never lets the in-flight horizon drop below one minute. */
const MIN_AGE_FLOOR_MINUTES = 1;

interface Args {
  list: boolean;
  key?: string;
  complete: boolean;
  clear: boolean;
  yes: boolean;
  olderThanMinutes: number;
  minAgeMinutes: number;
  limit: number;
  /** Which tuning flags were EXPLICITLY passed — a flag tuned for the other mode is a usage error, not a silent no-op (QA F2). */
  sawOlderThan: boolean;
  sawMinAge: boolean;
  sawLimit: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    list: false,
    complete: false,
    clear: false,
    yes: false,
    olderThanMinutes: DEFAULT_WEDGED_MIN_AGE_MINUTES,
    minAgeMinutes: DEFAULT_WEDGED_MIN_AGE_MINUTES,
    limit: DEFAULT_LIST_LIMIT,
    sawOlderThan: false,
    sawMinAge: false,
    sawLimit: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--list':
        args.list = true;
        break;
      case '--key':
        args.key = argv[++i];
        break;
      case '--complete':
        args.complete = true;
        break;
      case '--clear':
        args.clear = true;
        break;
      case '--yes':
        args.yes = true;
        break;
      case '--older-than-minutes':
      case '--min-age-minutes':
      case '--limit': {
        const raw = argv[++i];
        const n = Number(raw);
        if (raw === undefined || !Number.isFinite(n) || n <= 0) {
          throw new UsageError(`${a} needs a positive number, got ${JSON.stringify(raw)}`);
        }
        if (a === '--limit') {
          args.limit = Math.floor(n);
          args.sawLimit = true;
        } else if (a === '--older-than-minutes') {
          args.olderThanMinutes = n;
          args.sawOlderThan = true;
        } else {
          args.minAgeMinutes = Math.max(MIN_AGE_FLOOR_MINUTES, n);
          args.sawMinAge = true;
        }
        break;
      }
      default:
        throw new UsageError(`unknown argument ${a}`);
    }
  }
  return args;
}

class UsageError extends Error {}

function usage(): never {
  console.error(
    'usage: repair-cli --list [--older-than-minutes N] [--limit N]\n' +
      '       repair-cli --key <key> (--complete | --clear) [--min-age-minutes N] [--yes]',
  );
  process.exitCode = 2;
  throw new UsageError('bad usage');
}

function printRow(prefix: string, row: { key: string; operation: string; createdAt: Date; responseJson: string | null }): void {
  const ageMin = Math.round((Date.now() - row.createdAt.getTime()) / 60_000);
  console.log(`${prefix} key=${row.key} operation=${row.operation} ageMinutes≈${ageMin} responseJson=${row.responseJson === null ? 'NULL (wedged/in flight)' : 'set'}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    if (args.key || args.complete || args.clear || args.yes || args.sawMinAge) usage();
    const rows = await listWedgedKeys(db, { olderThanMinutes: args.olderThanMinutes, limit: args.limit });
    if (rows.length === 0) {
      console.log(`no wedged keys (NULL response older than ${args.olderThanMinutes} min)`);
      return;
    }
    console.log(`${rows.length} wedged key(s), oldest first (cutoff ${args.olderThanMinutes} min):`);
    for (const row of rows) printRow(' ', row);
    console.log('repair with: --key <key> (--complete | --clear) [--yes]');
    return;
  }

  if (!args.key || (args.complete === args.clear) || args.sawOlderThan || args.sawLimit) usage();
  const mode = args.complete ? 'complete' : 'clear';

  const outcome = await repairWedgedKey(db, args.key, {
    mode,
    confirm: args.yes,
    minAgeMinutes: args.minAgeMinutes,
  });

  switch (outcome.status) {
    case 'refused':
      // Only not-found arrives without a row (the other refusals carry one);
      // say so plainly instead of printing a phantom row (no NaN age, no
      // wedged/in-flight claim for a key that has no record).
      if (outcome.row) printRow('refused:', outcome.row);
      else console.log(`refused: key=${args.key} — no idempotency record with this key`);
      console.log(`  refusal: ${outcome.refusal} — nothing written`);
      process.exitCode = 4;
      return;
    case 'dry-run':
      printRow('dry run:', outcome.row);
      console.log(`  planned: ${outcome.plan}`);
      if (outcome.duplicateSendRisk) {
        console.log('  WARNING duplicate-send risk: clearing lets the next same-key request re-execute the operation.');
      }
      if (outcome.mode === 'complete') {
        console.log('  WARNING fabricated-success risk: completing makes every future same-key retry replay success');
        console.log('  without re-sending — if the mutation never actually happened, the operation never runs.');
      }
      console.log('  confirm against the tool log: an `idempotency completion failed for key` line means the provider');
      console.log('  mutation SUCCEEDED (prefer --complete); no line means crash-or-op-failure (--clear is the retry semantics).');
      console.log('  re-run with --yes to execute.');
      return;
    case 'completed':
      console.log(
        `repaired (complete): key=${outcome.row.key} operation=${outcome.row.operation} — responseJson now holds the repair marker`,
      );
      console.log('  same-key retries now replay the repair marker — no re-send.');
      return;
    case 'cleared':
      printRow('repaired (clear):', outcome.row);
      console.log('  reservation deleted — the next same-key request re-executes the operation.');
      return;
  }
}

main()
  .catch((err) => {
    if (err instanceof UsageError) {
      // usage() already printed the usage block (and set exitCode 2);
      // parseArgs' errors (unknown argument, bad number) did not — print the
      // message, and in every case leave exit code 2 as the header documents.
      if (process.exitCode !== 2) console.error(String(err.message));
      process.exitCode = 2;
      return;
    }
    console.error('repair failed:', err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
