/**
 * Production boot-refusal tests (#1 F1 and F5).
 *
 * F1: CORE_EVENTS_URL is optional in dev (drop-mode: events logged and
 * dropped, cursor still advances), but a production boot with the poll
 * worker enabled and no CORE_EVENTS_URL would silently and permanently drop
 * every inbound Telegram update — the boot must refuse. An ops-only
 * production instance (DISABLE_POLL_WORKER=true) may boot without it.
 *
 * F5: DATABASE_URL falls back to an empty connection string, so the service
 * boots looking healthy and fails on first use — a production boot without
 * it must refuse (readiness /readyz already reflects DB reachability).
 *
 * config.ts validates at import time under NODE_ENV, so each case spawns the
 * real modules in a child process (src/test/bootProbe.ts). An empty string
 * counts as unset for the probed variable (config's env() trims it) and keeps
 * dotenv from re-filling it from a developer's .env.
 */
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PRODUCTION = {
  NODE_ENV: 'production',
  TELEGRAM_TOOL_TOKEN: 'test-tool-token',
  TOKEN_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  // A syntactically valid URL nobody connects to — the probe never queries,
  // so it deliberately names no real user or database.
  DATABASE_URL: 'postgresql://probe@localhost:5432/probe',
  CORE_EVENTS_URL: 'http://hadron-server:4000/internal/telegram-events',
};

/** Run the boot probe under an explicit env; '' means "set but empty" (unset). */
async function boot(env: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  const childEnv = { ...process.env, ...env } as Record<string, string>;
  try {
    const { stdout, stderr } = await exec('node', ['--import', 'tsx', 'src/test/bootProbe.ts'], {
      cwd: repoRoot,
      env: childEnv,
    });
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('production boot refusals', () => {
  // Each case spawns a real child process over tsx — allow well over the
  // 5 s default so a slow CI host cannot flake these.
  const SLOW = 20_000;

  it(
    'F1: refuses to boot in production with the poll worker enabled and CORE_EVENTS_URL unset',
    async () => {
      const r = await boot({ ...PRODUCTION, CORE_EVENTS_URL: '' });
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(/CORE_EVENTS_URL is required in production/);
    },
    SLOW,
  );

  it(
    'F1: an ops-only production instance (DISABLE_POLL_WORKER=true) boots without CORE_EVENTS_URL',
    async () => {
      const r = await boot({ ...PRODUCTION, CORE_EVENTS_URL: '', DISABLE_POLL_WORKER: 'true' });
      expect(r.ok).toBe(true);
      expect(r.out).toContain('BOOT_OK');
    },
    SLOW,
  );

  it(
    'F1: development keeps drop-mode — no CORE_EVENTS_URL still boots',
    async () => {
      const r = await boot({ ...PRODUCTION, NODE_ENV: 'development', CORE_EVENTS_URL: '' });
      expect(r.ok).toBe(true);
      expect(r.out).toContain('BOOT_OK');
    },
    SLOW,
  );

  it(
    'F5: refuses to boot in production without DATABASE_URL',
    async () => {
      const r = await boot({ ...PRODUCTION, DATABASE_URL: '' });
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(/DATABASE_URL is required in production/);
    },
    SLOW,
  );

  it(
    'a fully configured production boot succeeds',
    async () => {
      const r = await boot({ ...PRODUCTION });
      expect(r.ok).toBe(true);
      expect(r.out).toContain('BOOT_OK');
    },
    SLOW,
  );
});
