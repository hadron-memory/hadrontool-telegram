/**
 * Prisma client singleton for the tool's own database.
 *
 * Prisma 7: the engine-less client gets its connection through the pg driver
 * adapter (the CLI reads the URL from prisma.config.ts instead).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { isProduction } from './config.js';

// #1 F5: an empty connection string let the service boot looking healthy
// (/healthz ok) while every DB-backed route, /readyz and the poller failed on
// first use. Refuse at boot in production; dev and tests keep their own URLs
// (vitest pins DATABASE_URL, dev reads .env). Readiness itself stays on
// /readyz (SELECT 1 → 503) — /healthz remains pure liveness so a DB blip
// never becomes a restart storm. The SAME trimmed value feeds the guard and
// the adapter, so a whitespace-only URL cannot pass one and fail the other.
const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
if (isProduction && !databaseUrl) {
  throw new Error('DATABASE_URL is required in production — refusing to start');
}

const adapter = new PrismaPg({ connectionString: databaseUrl });

export const db = new PrismaClient({ adapter });
export type Db = PrismaClient;
