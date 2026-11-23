/**
 * Subprocess pins for the repair CLI's operator contract (#11 fix cycle):
 * exit codes and refusal output. The CLI is a thin operator surface, so it is
 * pinned as it runs — `tsx src/ops/repair-cli.ts …` with the vitest env
 * inherited — never imported (importing runs main()).
 *
 *  - usage errors exit 2 with a message (LOCAL F2 / BLIND F2: parseArgs'
 *    UsageErrors used to leave exit code 0 while the header documented 2);
 *  - a not-found key exits 4 and says so plainly (LOCAL F3: the fallback row
 *    used to print `ageMinutes≈NaN` and `NULL (wedged/in flight)` for a row
 *    that does not exist);
 *  - the complete-mode dry run carries the fabricated-success warning
 *    (BLIND F3: clear's duplicate-send risk had a WARNING, complete's
 *    opposite failure had none).
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db.js';
import { resetDb } from '../test/fakes.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const tsxCli = new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url).pathname;

/** Run the CLI as the operator does; resolves stdout+stderr and the exit code. */
async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [tsxCli, 'src/ops/repair-cli.ts', ...args], {
      cwd: repoRoot,
      env: { ...process.env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let spy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetDb(db);
  spy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  spy.mockRestore();
});

describe('repair-cli — usage errors exit 2 (LOCAL F2 / BLIND F2)', () => {
  it('an unknown argument exits 2 with a message', async () => {
    const r = await cli(['--bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown argument');
  });

  it('a non-numeric --limit exits 2 with a message', async () => {
    const r = await cli(['--list', '--limit', 'abc']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--limit');
  });

  it('a tuning flag for the other mode is a usage error, not a silent no-op (QA F2)', async () => {
    // --min-age-minutes belongs to repair mode, not --list.
    const list = await cli(['--list', '--min-age-minutes', '5']);
    expect(list.code).toBe(2);
    // --older-than-minutes / --limit belong to --list, not repair mode.
    const repair = await cli(['--key', 'k-missing-cli-pin', '--complete', '--older-than-minutes', '5']);
    expect(repair.code).toBe(2);
  });
});

describe('repair-cli — not-found refusal exits 4 and prints no phantom row (LOCAL F3)', () => {
  it('names the missing key plainly, with no NaN age and no wedged/in-flight claim', async () => {
    const r = await cli(['--key', 'k-missing-cli-pin', '--complete']);
    expect(r.code).toBe(4);
    expect(r.stdout).toContain('k-missing-cli-pin');
    expect(r.stdout).toContain('not-found');
    expect(r.stdout).not.toContain('NaN');
    expect(r.stdout).not.toContain('wedged/in flight');
  });
});

describe('repair-cli — complete-mode dry run warns about the opposite failure (BLIND F3)', () => {
  it('prints the fabricated-success WARNING alongside the plan', async () => {
    await db.idempotencyRecord.create({
      data: {
        key: 'k-cli-warn',
        operation: 'send-message',
        requestHash: 'a',
        responseJson: null,
        createdAt: new Date(Date.now() - 30 * 60_000),
      },
    });
    const r = await cli(['--key', 'k-cli-warn', '--complete']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('dry run');
    expect(r.stdout).toContain('fabricated-success');
    // Dry run wrote nothing.
    const row = await db.idempotencyRecord.findUnique({ where: { key: 'k-cli-warn' } });
    expect(row!.responseJson).toBeNull();
  });
});
