import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../supabase/functions/mat-home-dashboard-api/index.ts', import.meta.url), 'utf8');
const testHash = createHash('sha256').update('test-code').digest('hex');
const javascript = stripTypeScriptTypes(source.replace(/^import .*;\n/, '').replace(/const SESSION_HASH = "[^"]+";/, `const SESSION_HASH = "${testHash}";`));
const plain = value => JSON.parse(JSON.stringify(value));
const fresh = () => ({ lastSyncedAt: new Date().toISOString(), stale: false });
const item = (id, registered_at, handled, quantity = 1) => ({ id, registered_at, handled, quantity });

function backend(rows = [], options = {}) {
  const calls = [];
  let handler;
  let lastSync = options.lastSync === undefined ? new Date().toISOString() : options.lastSync;
  const ctx = { Intl, Date, URL, Response, TextEncoder, AbortSignal, crypto: webcrypto,
    Deno: { env: { get: name => name === 'SUPABASE_URL' ? 'https://example.test' : 'test-key' }, serve: fn => { handler = fn; } },
    fetch: async (url, init) => {
      const u = new URL(url);
      calls.push(u);
      if (u.pathname.endsWith('/bol-sync-returns')) {
        assert.equal(init.headers.apikey, 'test-key');
        if (options.syncFails) return Response.json({ ok: false }, { status: 502 });
        lastSync = new Date().toISOString();
        return Response.json({ ok: true });
      }
      if (u.pathname.endsWith('/returns')) {
        if (options.readFails) return Response.json({}, { status: 503 });
        const offset = Number(u.searchParams.get('offset') || 0);
        return Response.json(rows.slice(offset, offset + 1000));
      }
      if (u.pathname.endsWith('/sync_runs') && u.searchParams.get('source') === 'eq.bol_returns') {
        return Response.json(lastSync ? [{ finished_at: lastSync }] : []);
      }
      return Response.json([]);
    }
  };
  runInNewContext(javascript, ctx);
  return { ctx, calls, request: (query = '', code = 'test-code') => handler(new Request(`https://example.test/api${query}`, { headers: { 'x-dashboard-code': code } })) };
}

test('totals use Amsterdam registration dates; open items include every period', async () => {
  const { ctx } = backend([
    item('old', '2026-09-05T12:00:00Z', false, 2),
    item('before', '2026-09-30T21:59:59Z', 'false'),
    item('start', '2026-09-30T22:00:00Z', 'true', 2),
    item('end', '2026-10-16T21:59:59Z', false, 3),
    item('after', '2026-10-16T22:00:00Z', true)
  ]);
  const result = await ctx.returnSummary('2026-10-01', '2026-10-16', fresh());
  assert.equal(result.available, true);
  assert.equal(result.open, 6);
  assert.equal(result.total, 5);
  const emptyPeriod = await ctx.returnSummary('2026-10-12', '2026-10-12', fresh());
  assert.equal(emptyPeriod.total, 0);
  assert.equal(emptyPeriod.open, 6);
});

test('pagination includes more than 1000 return items without double counting', async () => {
  const { ctx, calls } = backend(Array.from({ length: 1005 }, (_, id) => item(id, '2026-10-10T12:00:00Z', id % 2 !== 0)));
  const result = await ctx.returnSummary('2026-10-01', '2026-10-16', fresh());
  assert.equal(result.total, 1005);
  assert.equal(result.open, 503);
  assert.deepEqual(calls.map(u => u.searchParams.get('offset')), ['0', '1000', '1005']);
});

test('winter-time boundary and fallback registration date are handled', async () => {
  const { ctx } = backend([
    item('a', '2026-10-25T00:30:00Z', true),
    { ...item('b', null, false), return_date: '2026-10-25T01:30:00Z' },
    item('c', '2026-10-25T23:00:00Z', false)
  ]);
  const result = await ctx.returnSummary('2026-10-25', '2026-10-25', fresh());
  assert.equal(result.total, 2);
  assert.equal(result.open, 2);
});

test('refresh failure preserves existing totals and marks their age', async () => {
  const lastSync = '2026-10-09T12:00:00Z';
  const { ctx } = backend([item('a', '2026-10-06T12:00:00Z', false)], { lastSync, syncFails: true });
  const state = await ctx.syncReturns(true);
  assert.deepEqual(plain(state), { lastSyncedAt: lastSync, stale: true });
  const result = await ctx.returnSummary('2026-10-01', '2026-10-16', state);
  assert.equal(result.available, true);
  assert.equal(result.total, 1);
  assert.equal(result.stale, true);
});

test('failed queries, unknown statuses and unsynchronized tables never become zero', async () => {
  for (const instance of [backend([], { readFails: true }), backend([item('a', '2026-10-06T12:00:00Z', null)]), backend([item('a', null, false)])]) {
    const result = await instance.ctx.returnSummary('2026-10-01', '2026-10-16', fresh());
    assert.equal(result.available, false);
    assert.equal(result.total, null);
    assert.equal(result.open, null);
  }
  const { ctx } = backend([]);
  const result = await ctx.returnSummary('2026-10-01', '2026-10-16', { lastSyncedAt: null, stale: true });
  assert.equal(result.available, false);
});

test('fresh data skips synchronization; manual and stale requests synchronize', async () => {
  const { ctx, calls } = backend();
  await ctx.syncReturns();
  assert.equal(calls.filter(u => u.pathname.endsWith('/bol-sync-returns')).length, 0);
  await Promise.all([ctx.syncReturns(true), ctx.syncReturns(true)]);
  assert.equal(calls.filter(u => u.pathname.endsWith('/bol-sync-returns')).length, 1);
  const old = backend([], { lastSync: '2026-10-09T12:00:00Z' });
  const result = await old.ctx.syncReturns();
  assert.equal(result.stale, false);
  assert.equal(old.calls.filter(u => u.pathname.endsWith('/bol-sync-returns')).length, 1);
});

test('authenticated dashboard response contains returns without changing other totals', async () => {
  const { request } = backend([item('a', '2026-10-06T12:00:00Z', false)]);
  const response = await request('?from=2026-10-01&to=2026-10-16');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.returns.total, 1);
  assert.equal(body.returns.open, 1);
  assert.equal(body.kpis.ordersToday, 0);
  assert.equal(body.kpis.revenueToday, 0);
  assert.equal(body.ordersSeries.length, 16);
  const failing = backend([], { readFails: true });
  const partial = await (await failing.request('?from=2026-10-01&to=2026-10-16')).json();
  assert.equal(partial.ok, true);
  assert.equal(partial.returns.available, false);
});

test('authentication still rejects unauthenticated requests before any data access', async () => {
  const { request, calls } = backend();
  const response = await request('', 'wrong-code');
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test('frontend updates return counters with the overview filter and shows missing data distinctly', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {} });
    return elements.get(id);
  };
  const document = { hidden: false, getElementById: element, querySelector: element, querySelectorAll: () => [], addEventListener() {} };
  const ctx = { document, Intl, Date, URL, console, alert() {}, setTimeout() {}, setInterval() {},
    window: { MAT_HOME_CONFIG: { dashboardApi: 'https://example.test/api' } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async url => {
      const u = new URL(url), from = u.searchParams.get('from'), to = u.searchParams.get('to');
      return { ok: true, status: 200, json: async () => ({ selectedRange: { from, to }, kpis: {}, returns: { available: true, open: 3, total: from === '2026-10-01' ? 7 : 1, ...fresh() } }) };
    }
  };
  const frontend = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'window.test={applyOverview,renderReturns};})();');
  runInNewContext(frontend, ctx);
  element('overviewPreset').value = 'custom';
  element('overviewFrom').value = '2026-10-01';
  element('overviewTo').value = '2026-10-16';
  await ctx.window.test.applyOverview();
  assert.equal(element('returnsTotal').textContent, '7');
  assert.equal(element('returnsOpen').textContent, '3');
  element('overviewFrom').value = '2026-10-16';
  await ctx.window.test.applyOverview();
  assert.equal(element('returnsTotal').textContent, '1');
  assert.equal(element('returnsOpen').textContent, '3');
  ctx.window.test.renderReturns({ available: true, total: 0, open: 0, stale: true, lastSyncedAt: '2026-10-09T12:00:00Z' }, 'periode');
  assert.equal(element('returnsTotal').textContent, '0');
  assert.match(element('returnsSyncStatus').textContent, /Verversen niet gelukt/);
  ctx.window.test.renderReturns({ available: false, total: null, open: null }, 'periode');
  assert.equal(element('returnsTotal').textContent, '—');
  assert.equal(element('returnsOpen').textContent, '—');
});
