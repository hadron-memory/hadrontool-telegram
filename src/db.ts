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
// never becomes a restart storm.
if (isProduction && !process.env.DATABASE_URL?.trim()) {
  throw new Error('DATABASE_URL is required in production — refusing to start');
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });

export const db = new PrismaClient({ adapter });
export type Db = PrismaClient;
