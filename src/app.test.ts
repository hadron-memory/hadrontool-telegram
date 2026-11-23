/**
 * Health/readiness surface pins (#1 F5): the DB-unreachable split.
 *
 * /readyz is the readiness probe — it must answer 503 when the database
 * cannot be reached, so an orchestrator stops routing before routes fail.
 * /healthz stays pure liveness (200 while the process is up) so a DB blip
 * never becomes a restart storm: killing a healthy process over a transient
 * DB outage would also kill the in-flight pacer queue and every long poll.
 *
 * Uses a stub db (no real Postgres) — these pins are about the HTTP surface's
 * behavior on a DB fault, not about Postgres itself.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { Db } from './db.js';
import { fakeProvider } from './test/fakes.js';

const noopForward = async () => true;

/** Minimal db double: only $queryRaw matters to these routes. */
function stubDb(queryRaw: () => Promise<unknown>): Db {
  return { $queryRaw: queryRaw } as unknown as Db;
}

describe('GET /readyz', () => {
  it('answers 503 when the database is unreachable', async () => {
    const app = createApp(stubDb(() => Promise.reject(new Error('connection refused'))), fakeProvider(), noopForward);
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, db: false });
  });

  it('answers 200 ok when the database answers', async () => {
    const app = createApp(stubDb(() => Promise.resolve(1)), fakeProvider(), noopForward);
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: true });
  });
});

describe('GET /healthz under the same DB fault', () => {
  it('stays 200 — liveness is about the process, not the database', async () => {
    const app = createApp(stubDb(() => Promise.reject(new Error('connection refused'))), fakeProvider(), noopForward);
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
