import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildContext } from '../src/app.ts';
import type { AppContext } from '../src/app.ts';
import { createApp } from '../src/server/http.ts';
import { manualClock } from '../src/util/ids.ts';

let server: Server;
let base: string;
let ctx: AppContext;
before(async () => {
  ctx = buildContext({}, { clock: manualClock() });
  server = createApp(ctx);
  await new Promise<void>((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((ok) => server.close(() => ok())));

const j = async (path: string, init?: RequestInit) => {
  const r = await fetch(base + path, init);
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, body };
};
const post = (path: string, body: unknown) => j(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

test('health and scenario list', async () => {
  const h = await j('/healthz');
  assert.deepEqual(h.body, { ok: true, mode: 'SIMULATED', llm: 'heuristic' });
  assert.ok((await j('/api/demo/scenarios')).body.includes('inr-strong'));
});

test('seed, review, approve and resolve a dispute over HTTP', async () => {
  const seeded = await post('/api/demo/scenario', { name: 'inr-strong' });
  assert.equal(seeded.status, 200);
  const id = seeded.body.id;
  assert.equal(seeded.body.recommendation, 'FIGHT');
  assert.ok(seeded.body.evidence.length >= 6);

  const list = await j('/api/cases');
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].state, 'AWAITING_APPROVAL');

  const pid = seeded.body.analysis.proposals[0].id;
  const approved = await post(`/api/cases/${id}/approve`, { proposal_id: pid, approver: 'merchant@example.com' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.state, 'WAITING');
  const again = await post(`/api/cases/${id}/approve`, { proposal_id: pid });
  assert.equal(again.status, 409);

  await post('/api/demo/adjudicate', { dispute_id: seeded.body.dispute_id, outcome: 'SELLER_FAVOR' });
  const done = await j(`/api/cases/${id}`);
  assert.equal(done.body.state, 'CLOSED');
  assert.equal(done.body.outcome.result, 'WON');
  const k = await j('/api/kpis');
  assert.equal(k.body.recovered, 100);
  assert.deepEqual(k.body.audit, { ok: true });
});

test('a rejected proposal is recorded and the case stays open', async () => {
  const seeded = await post('/api/demo/scenario', { name: 'inr-weak' });
  const r = await post(`/api/cases/${seeded.body.id}/reject`, { proposal_id: seeded.body.analysis.proposals[0].id, approver: 'm', reason: 'Prefer to escalate' });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'AWAITING_APPROVAL');
  assert.equal(Object.values<any>(r.body.rejected)[0].reason, 'Prefer to escalate');
});

test('webhook endpoint rejects unsigned requests and unknown routes 404', async () => {
  const bad = await post('/webhooks/paypal', { id: 'x', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'nope' } });
  assert.equal(bad.status, 400);
  assert.equal((await j('/api/cases/nope')).status, 404);
  assert.equal((await j('/nothing-here')).status, 404);
  assert.equal((await post('/api/demo/scenario', { name: 'bogus' })).status, 400);
});

test('simulated checkout redirects through approval and captures the order into the vault', async () => {
  const co = await post('/api/checkout', { sku: 'lantern' });
  assert.equal(co.status, 200);
  const token = co.body.approve_url.split('token=')[1];
  const approve = await fetch(`${base}/sim/approve?token=${token}`, { redirect: 'manual' });
  assert.equal(approve.status, 302);
  const ret = await j(`/paypal/return?token=${token}`);
  assert.equal(ret.status, 200);
  assert.match(ret.body, /Payment received/);
  const orders = await j('/api/orders');
  const o = orders.body.find((x: any) => x.paypal_order_id === token);
  assert.equal(o.status, 'CAPTURED');
  assert.equal(ctx.vault.forTransaction(o.capture_id).length, 3);
  const shipped = await post(`/api/orders/${o.id}/ship`, { carrier: 'UPS', tracking_number: '1ZABC' });
  assert.equal(shipped.body.status, 'SHIPPED');
});

test('the console page is served as HTML', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await r.text(), /<title>Dispute Desk<\/title>/);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
});

test('the check endpoint dry-runs edits without changing anything', async () => {
  const seeded = await post('/api/demo/scenario', { name: 'inr-strong' });
  const pid = seeded.body.analysis.proposals[0].id;
  assert.equal(seeded.body.policy[pid].ok, true);
  const bad = await post(`/api/cases/${seeded.body.id}/check`, { proposal_id: pid, edits: { notes: 'The buyer signed for the parcel personally and confirmed it.' } });
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.violations[0].code, 'UNCITED_CLAIM');
  const good = await post(`/api/cases/${seeded.body.id}/check`, { proposal_id: pid, edits: { notes: `The parcel was delivered on October 8 [${seeded.body.evidence[0].id}].` } });
  assert.equal(good.body.ok, true);
  const foreign = await post(`/api/cases/${seeded.body.id}/check`, { proposal_id: pid, edits: { notes: 'The parcel was delivered on October 8 [EV-9999].' } });
  assert.equal(foreign.body.violations[0].code, 'UNKNOWN_CITATION');
  const after = await j(`/api/cases/${seeded.body.id}`);
  assert.equal(after.body.state, 'AWAITING_APPROVAL');
  assert.equal(after.body.analysis.proposals[0].params.notes, seeded.body.analysis.proposals[0].params.notes);
});
