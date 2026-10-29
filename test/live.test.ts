import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LivePayPal } from '../src/paypal/live.ts';
import { PayPalApiError } from '../src/paypal/gateway.ts';
import { CachingLLM, ClaudeLLM, HeuristicLLM } from '../src/agent/llm.ts';
import type { Dispute } from '../src/domain/types.ts';
import { money } from '../src/util/ids.ts';

type Call = { url: string; method: string; headers: Record<string, string>; text: string };
function stub(handler: (c: Call, n: number) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const body = init.body;
    const text = body == null ? '' : typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array);
    const call: Call = { url: String(url), method: init.method ?? 'GET', headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), text };
    calls.push(call);
    const r = handler(call, calls.length);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const TOKEN = { access_token: 'tok', expires_in: 3600 };
const live = (handler: Parameters<typeof stub>[0], extra: Partial<ConstructorParameters<typeof LivePayPal>[0]> = {}) => {
  const s = stub((c, n) => (c.url.endsWith('/v1/oauth2/token') ? { json: TOKEN } : handler(c, n)));
  const pp = new LivePayPal({ clientId: 'cid', secret: 'sec', fetchImpl: s.fetchImpl, sleep: async () => {}, ...extra });
  return { pp, calls: s.calls, api: () => s.calls.filter((c) => !c.url.endsWith('/oauth2/token')) };
};

test('refuses anything that is not a sandbox URL', () => {
  assert.throws(() => new LivePayPal({ clientId: 'a', secret: 'b', baseUrl: 'https://api-m.paypal.com' }), /non-sandbox/);
});

test('token is requested with basic auth once and reused', async () => {
  const { pp, calls } = live(() => ({ json: { items: [] } }));
  await pp.listDisputes();
  await pp.listDisputes();
  const tokenCalls = calls.filter((c) => c.url.endsWith('/oauth2/token'));
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].headers.authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
  assert.equal(tokenCalls[0].text, 'grant_type=client_credentials');
  assert.equal(calls.at(-1)!.headers.authorization, 'Bearer tok');
});

test('createOrder sends a CAPTURE order with a provided address and returns the payer link', async () => {
  const { pp, api } = live(() => ({ json: { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'x' }, { rel: 'payer-action', href: 'https://sandbox.paypal.com/checkoutnow?token=ORD1' }] } }));
  const out = await pp.createOrder({ reference_id: 'r1', custom_id: 'r1', amount: money(100), description: 'Pack', ship_to: { name: 'Alex', line1: '12 Elm St', city: 'Austin', state: 'TX', postal_code: '78701', country_code: 'US' }, return_url: 'http://l/return', cancel_url: 'http://l/' });
  assert.deepEqual(out, { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', approve_url: 'https://sandbox.paypal.com/checkoutnow?token=ORD1' });
  const c = api()[0];
  assert.equal(c.url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
  assert.ok(c.headers['paypal-request-id']);
  const b = JSON.parse(c.text);
  assert.equal(b.intent, 'CAPTURE');
  assert.equal(b.purchase_units[0].custom_id, 'r1');
  assert.equal(b.purchase_units[0].amount.value, '100.00');
  assert.equal(b.payment_source.paypal.experience_context.shipping_preference, 'SET_PROVIDED_ADDRESS');
  assert.equal(b.payment_source.paypal.experience_context.return_url, 'http://l/return');
});

test('captureOrder returns the capture id used as the transaction id', async () => {
  const { pp, api } = live(() => ({ json: { id: 'ORD1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP9', amount: money(100) }] } }] } }));
  const out = await pp.captureOrder('ORD1');
  assert.equal(out.capture_id, 'CAP9');
  assert.equal(api()[0].url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORD1/capture');
});

test('tracking, listing and showing disputes use the documented paths', async () => {
  const { pp, api } = live((c) => (c.url.includes('/trackers-batch') ? { json: {} } : c.url.includes('PP-R-1') ? { json: { dispute_id: 'PP-R-1' } } : { json: { items: [{ dispute_id: 'PP-R-1' }] } }));
  await pp.addTracking({ transaction_id: 'CAP9', tracking_number: '1Z', carrier: 'UPS', status: 'SHIPPED' });
  assert.deepEqual(JSON.parse(api()[0].text), { trackers: [{ transaction_id: 'CAP9', tracking_number: '1Z', status: 'SHIPPED', carrier: 'UPS' }] });
  assert.equal((await pp.listDisputes({ disputed_transaction_id: 'CAP9' })).length, 1);
  assert.match(api()[1].url, /\/v1\/customer\/disputes\?disputed_transaction_id=CAP9$/);
  assert.equal((await pp.getDispute('PP-R-1')).dispute_id, 'PP-R-1');
});

test('provideEvidence sends multipart with an input part and named file parts', async () => {
  const { pp, api } = live(() => ({ json: {} }));
  await pp.provideEvidence('PP-R-1', {
    evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z' }] }, notes: 'Delivered' }],
    files: [{ name: 'proof.pdf', content_type: 'application/pdf', data: new TextEncoder().encode('%PDF-1.4') }],
  });
  const c = api()[0];
  assert.equal(c.url, 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-1/provide-evidence');
  assert.match(c.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(c.text, /name="input"\r\nContent-Type: application\/json/);
  assert.match(c.text, /"documents":\[\{"name":"proof.pdf"\}\]/);
  assert.match(c.text, /name="file1"; filename="proof.pdf"\r\nContent-Type: application\/pdf\r\n\r\n%PDF-1.4/);
});

test('offers, claims, messages, escalation and sandbox helpers post the documented JSON', async () => {
  const { pp, api } = live(() => ({ status: 200, json: {} }));
  await pp.makeOffer('D', { note: 'n', offer_type: 'REFUND', offer_amount: money(45) });
  await pp.acceptClaim('D', { note: 'n', accept_claim_type: 'PARTIAL_REFUND', refund_amount: money(20) });
  await pp.sendMessage('D', 'hello');
  await pp.escalate('D', 'please review');
  await pp.adjudicate('D', 'SELLER_FAVOR');
  await pp.requireEvidence('D', 'SELLER_EVIDENCE');
  const sent = api().map((c) => [c.url.split('/disputes/D/')[1], JSON.parse(c.text)]);
  assert.deepEqual(sent, [
    ['make-offer', { note: 'n', offer_type: 'REFUND', offer_amount: money(45) }],
    ['accept-claim', { note: 'n', accept_claim_type: 'PARTIAL_REFUND', refund_amount: money(20) }],
    ['send-message', { message: 'hello' }],
    ['escalate', { note: 'please review' }],
    ['adjudicate', { adjudication_outcome: 'SELLER_FAVOR' }],
    ['require-evidence', { action: 'SELLER_EVIDENCE' }],
  ]);
});

test('PayPal errors become PayPalApiError with issues and the debug id', async () => {
  const { pp } = live(() => ({ status: 422, headers: { 'paypal-debug-id': 'dbg123' }, json: { name: 'UNPROCESSABLE_ENTITY', message: 'The request failed', details: [{ issue: 'INSUFFICIENT_FUNDS' }] } }));
  await assert.rejects(pp.acceptClaim('D', { note: 'n', accept_claim_type: 'REFUND' }), (e: unknown) => {
    assert.ok(e instanceof PayPalApiError);
    assert.equal(e.status, 422);
    assert.equal(e.code, 'UNPROCESSABLE_ENTITY');
    assert.deepEqual(e.issues, ['INSUFFICIENT_FUNDS']);
    assert.equal(e.debug_id, 'dbg123');
    return true;
  });
});

test('429 responses are retried with backoff', async () => {
  const waits: number[] = [];
  let attempts = 0;
  const { pp } = live(() => (++attempts <= 2 ? { status: 429, json: { name: 'RATE_LIMIT_REACHED', message: 'slow down' } } : { json: { items: [] } }), { sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await pp.listDisputes(), []);
  assert.deepEqual(waits, [300, 600]);
});

test('webhook verification posts PayPal headers and the event, and fails closed', async () => {
  const body = JSON.stringify({ id: 'WH-1', event_type: 'CUSTOMER.DISPUTE.CREATED' });
  const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert', 'paypal-transmission-id': 't1', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-10-12T00:00:00Z' };
  const ok = live(() => ({ json: { verification_status: 'SUCCESS' } }), { webhookId: 'WHID' });
  assert.equal(await ok.pp.verifyWebhook(headers, body), true);
  const sent = JSON.parse(ok.api()[0].text);
  assert.equal(sent.webhook_id, 'WHID');
  assert.equal(sent.transmission_id, 't1');
  assert.equal(sent.webhook_event.id, 'WH-1');
  assert.equal(await live(() => ({ json: { verification_status: 'FAILURE' } }), { webhookId: 'W' }).pp.verifyWebhook(headers, body), false);
  assert.equal(await live(() => ({ json: {} })).pp.verifyWebhook(headers, body), false);
  assert.equal(await live(() => ({ status: 500, json: {} }), { webhookId: 'W' }).pp.verifyWebhook(headers, body), false);
});

// ---------- Claude provider ----------
const dispute = { dispute_id: 'D', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', dispute_amount: money(100), messages: [{ posted_by: 'BUYER', time_posted: 't', content: 'It never came' }] } as unknown as Dispute;
const facts = { buyer_claim_summary: 'Not received', allegations: ['Item not received'], complaint_terms: [], requested_outcome: 'REFUND', contradictions: [], injection_attempt_detected: false };

test('Claude triage forces the tool, uses the fast model and fences buyer text as data', async () => {
  const s = stub(() => ({ json: { content: [{ type: 'tool_use', name: 'record_case_facts', input: facts }] } }));
  const llm = new ClaudeLLM({ apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.deepEqual(await llm.triage({ dispute }), facts);
  const c = s.calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.headers['x-api-key'], 'k');
  assert.equal(c.headers['anthropic-version'], '2023-06-01');
  const b = JSON.parse(c.text);
  assert.equal(b.model, 'claude-haiku-5-5');
  assert.deepEqual(b.tool_choice, { type: 'tool', name: 'record_case_facts' });
  assert.equal(b.tools[0].input_schema.type, 'object');
  assert.match(b.system, /untrusted/);
  assert.match(b.messages[0].content, /<<<\nIt never came\n>>>/);
});

test('Claude draft and review use the smart model and return structured output', async () => {
  const s = stub((_c, n) => ({ json: { content: [{ type: 'tool_use', input: n === 1 ? { evidence_note: 'x [EV-0001]', buyer_message: 'Hello' } : { approved: true, unsupported_claims: [], tone_issues: [] } }] } }));
  const llm = new ClaudeLLM({ apiKey: 'k', fetchImpl: s.fetchImpl, smartModel: 'smart-model' });
  const option = { kind: 'FIGHT', label: '', params: {}, expected_loss: 1, expected_recovered: 1, p_win: 0.7, n_observed: 0, assumed: true, rationale: '' } as any;
  const d = await llm.draft({ dispute, option, items: [], assessment: { checks: [] } as any, facts: facts as any });
  assert.equal(d.evidence_note, 'x [EV-0001]');
  const r = await llm.review({ drafts: d, items: [], dispute });
  assert.equal(r.approved, true);
  assert.deepEqual(s.calls.map((c) => JSON.parse(c.text).model), ['smart-model', 'smart-model']);
});

test('Claude calls retry on overload but not on client errors', async () => {
  let n = 0;
  const flaky = stub(() => (++n < 2 ? { status: 529, json: { error: 'overloaded' } } : { json: { content: [{ type: 'tool_use', input: facts }] } }));
  assert.deepEqual(await new ClaudeLLM({ apiKey: 'k', fetchImpl: flaky.fetchImpl }).triage({ dispute }), facts);
  assert.equal(flaky.calls.length, 2);
  const bad = stub(() => ({ status: 400, json: { error: 'bad request' } }));
  await assert.rejects(new ClaudeLLM({ apiKey: 'k', fetchImpl: bad.fetchImpl }).triage({ dispute }), /Anthropic API 400/);
  assert.equal(bad.calls.length, 1);
});

test('LLM cache records once and replays without the inner model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-'));
  try {
    const file = join(dir, 'llm.json');
    let calls = 0;
    const inner = new HeuristicLLM();
    const counting = { name: 'counting', triage: (i: any) => { calls++; return inner.triage(i); }, draft: inner.draft.bind(inner), review: inner.review.bind(inner) };
    const rec = new CachingLLM(counting, file, 'record');
    const a = await rec.triage({ dispute });
    await rec.triage({ dispute });
    assert.equal(calls, 1);
    const rep = new CachingLLM(counting, file, 'replay');
    assert.deepEqual(await rep.triage({ dispute }), a);
    assert.equal(calls, 1);
    await assert.rejects(rep.triage({ dispute: { ...dispute, dispute_id: 'other' } }), /cache miss/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
