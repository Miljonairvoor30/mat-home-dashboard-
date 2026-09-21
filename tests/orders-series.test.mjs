// Run with Node.js 24+: node --test tests/orders-series.test.mjs
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../supabase/functions/mat-home-dashboard-api/index.ts', import.meta.url), 'utf8');
const javascript = stripTypeScriptTypes(source.replace(/^import .*;\n/, ''));
function backend(orders) {
  const context = { Intl, Date, URL, Response, TextEncoder, crypto: webcrypto,
    Deno: { env: { get: () => 'test' }, serve: () => {} },
    fetch: async url => {
      const u = new URL(url.replace('test/', 'https://example.test/'));
      const offset = Number(u.searchParams.get('offset') || 0);
      return Response.json(orders.slice(offset, offset + 1000));
    }
  };
  runInNewContext(javascript, context);
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('counts orders once, includes empty days, and respects Amsterdam midnight', async () => {
  const ctx = backend([
    { id: 'a', ordered_at: '2026-09-16T21:59:59Z' },
    { id: 'b', ordered_at: '2026-09-16T22:00:00Z' },
    { id: 'c', ordered_at: '2026-09-17T21:59:59Z' },
    { id: 'd', ordered_at: '2026-09-18T22:00:00Z' },
    { id: 'e', ordered_at: '2026-09-19T22:00:00Z' }
  ]);
  assert.deepEqual(plain(await ctx.dailyOrders('2026-09-17', '2026-09-19')), [
    { date: '2026-09-17', orders: 2 },
    { date: '2026-09-18', orders: 0 },
    { date: '2026-09-19', orders: 1 }
  ]);
  assert.deepEqual(plain(await ctx.dailyOrders('2026-09-18', '2026-09-18')), [{ date: '2026-09-18', orders: 0 }]);
});

test('does not truncate a selected period at 1000 orders', async () => {
  const ctx = backend(Array.from({ length: 1005 }, (_, id) => ({ id, ordered_at: '2026-09-20T12:00:00Z' })));
  assert.deepEqual(plain(await ctx.dailyOrders('2026-09-20', '2026-09-20')), [{ date: '2026-09-20', orders: 1005 }]);
});

test('groups both occurrences of the winter-time clock change on the same day', async () => {
  const ctx = backend([
    { id: 'a', ordered_at: '2026-10-25T00:30:00Z' },
    { id: 'b', ordered_at: '2026-10-25T01:30:00Z' },
    { id: 'c', ordered_at: '2026-10-25T23:00:00Z' }
  ]);
  assert.deepEqual(plain(await ctx.dailyOrders('2026-10-25', '2026-10-26')), [
    { date: '2026-10-25', orders: 2 }, { date: '2026-10-26', orders: 1 }
  ]);
});
