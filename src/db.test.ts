/**
 * #1 F5 (review delta, #10): db.ts must hand the pg adapter the SAME trimmed
 * DATABASE_URL its production guard judged. Outside production the guard is
 * silent, so there a whitespace-only value would otherwise reach the adapter
 * raw and every connection attempt would use a garbage connection string.
 *
 * Both collaborators are captured at construction — nothing connects.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const constructed = vi.hoisted(() => {
  /** Every FakeAdapter built, one per db.js import. */
  const adapters: FakeAdapter[] = [];
  /** Stand-in for PrismaPg: remembers the options it was built with. */
  class FakeAdapter {
    readonly options: unknown;
    constructor(options: unknown) {
      this.options = options;
      adapters.push(this);
    }
  }
  return {
    FakeAdapter,
    /** Every FakeAdapter built, one per db.js import. */
    adapters,
    /** The options `new PrismaClient(...)` received, one per db.js import. */
    clients: [] as { adapter: unknown }[],
  };
});

vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: constructed.FakeAdapter }));

vi.mock('./generated/prisma/client.js', () => ({
  PrismaClient: class {
    constructor(options: { adapter: unknown }) {
      constructed.clients.push(options);
    }
  },
}));

afterEach(() => {
  constructed.adapters.length = 0;
  constructed.clients.length = 0;
});

/** Import db.js fresh under one DATABASE_URL (`undefined` = unset), then restore the env. */
async function importDbUnder(databaseUrl: string | undefined): Promise<void> {
  const previous = process.env.DATABASE_URL;
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
  vi.resetModules();
  try {
    await import('./db.js');
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

describe('db: one trimmed DATABASE_URL for the guard and the adapter', () => {
  it('a whitespace-only DATABASE_URL reaches the adapter as the empty string', async () => {
    await importDbUnder('   ');

    expect(constructed.adapters.map((adapter) => adapter.options)).toEqual([{ connectionString: '' }]);
  });

  it('a padded DATABASE_URL reaches the adapter trimmed', async () => {
    await importDbUnder('  postgresql://probe@localhost:5432/probe\n');

    expect(constructed.adapters.map((adapter) => adapter.options)).toEqual([
      { connectionString: 'postgresql://probe@localhost:5432/probe' },
    ]);
  });

  it('the client is built on that adapter — not a second one built from the raw value', async () => {
    await importDbUnder('  postgresql://probe@localhost:5432/probe  ');

    const [client] = constructed.clients;
    const [adapter] = constructed.adapters;
    expect(constructed.clients).toHaveLength(1);
    expect(client?.adapter).toBe(adapter);
    expect(adapter?.options).toEqual({ connectionString: 'postgresql://probe@localhost:5432/probe' });
  });
});
