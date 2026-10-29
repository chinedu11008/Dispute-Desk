import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedPayPal, errdis } from '../src/paypal/simulator.ts';
import { PayPalApiError } from '../src/paypal/gateway.ts';
import { buildMultipart } from '../src/util/multipart.ts';
import { manualClock, money } from '../src/util/ids.ts';

async function setup(opts: ConstructorParameters<typeof SimulatedPayPal>[0] = {}) {
  const clock = manualClock();
  const events: string[] = [];
  const sim = new SimulatedPayPal({ clock, sink: (e) => { events.push(e.event_type); }, ...opts });
  const o = await sim.createOrder({ reference_id: 'r1', amount: money(100), ship_to: { line1: '12 Elm St', city: 'Austin', postal_code: '78701', country_code: 'US' }, return_url: 'x', cancel_url: 'y' });
  sim.approveOrder(o.id);
  const cap = await sim.captureOrder(o.id);
  return { sim, clock, events, cap: cap.capture_id };
}
const rels = (d: { links: { rel: string }[] }) => d.links.map((l) => l.rel).sort();
const fails = async (p: Promise<unknown>, code: string, issue?: string) => {
  await assert.rejects(p, (e: any) => e instanceof PayPalApiError && e.code === code && (!issue || e.issues.includes(issue)));
};

test('order must be approved before capture; capture credits the balance', async () => {
  const sim = new SimulatedPayPal({ balance: 0 });
  const o = await sim.createOrder({ reference_id: 'r', amount: money(40), ship_to: { line1: 'a', city: 'b', postal_code: '1', country_code: 'US' }, return_url: 'x', cancel_url: 'y' });
  await fails(sim.captureOrder(o.id), 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED');
  sim.approveOrder(o.id);
  await sim.captureOrder(o.id);
  assert.equal(sim.balance, 40);
});

test('a new INR dispute starts in INQUIRY, waits for the seller and emits CREATED', async () => {
  const { sim, events, cap } = await setup();
  const d = sim.createBuyerDispute({ capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', message: 'It never arrived' });
  await sim.settle();
  assert.equal(d.dispute_life_cycle_stage, 'INQUIRY');
  assert.equal(d.status, 'WAITING_FOR_SELLER_RESPONSE');
  assert.deepEqual(rels(d), ['accept-claim', 'escalate', 'make-offer', 'provide-evidence', 'self', 'send-message']);
  assert.deepEqual(d.allowed_response_options?.make_offer?.offer_types, ['REFUND']);
  assert.equal(d.evidences?.[0].evidence_type, 'PROOF_OF_FULFILLMENT');
  assert.deepEqual(events, ['CUSTOMER.DISPUTE.CREATED']);
  assert.equal((await sim.listDisputes({ disputed_transaction_id: cap })).length, 1);
});

test('defend path: evidence moves the case under review, adjudication resolves it in the seller favour', async () => {
  const { sim, events, cap } = await setup();
  const d = sim.createBuyerDispute({ capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' });
  await sim.provideEvidence(d.dispute_id, { evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z' }] }, notes: 'x' }] });
  const mid = await sim.getDispute(d.dispute_id);
  assert.equal(mid.status, 'UNDER_REVIEW');
  assert.ok(rels(mid).includes('adjudicate'));
  assert.ok(!rels(mid).includes('provide-evidence'));
  await sim.adjudicate(d.dispute_id, 'SELLER_FAVOR');
  const end = await sim.getDispute(d.dispute_id);
  assert.equal(end.status, 'RESOLVED');
  assert.equal(end.dispute_outcome?.outcome_code, 'RESOLVED_SELLER_FAVOUR');
  assert.equal(sim.balance, 5100);
  await sim.settle();
  assert.deepEqual(events, ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED']);
});

test('offer path: seller offer, buyer accepts, refund is paid', async () => {
  const { sim, cap } = await setup();
  const d = sim.createBuyerDispute({ capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' });
  await sim.makeOffer(d.dispute_id, { note: 'Sorry about this', offer_type: 'REFUND', offer_amount: money(50) });
  assert.equal((await sim.getDispute(d.dispute_id)).status, 'WAITING_FOR_BUYER_RESPONSE');
  sim.buyerAcceptsOffer(d.dispute_id);
  const end = await sim.getDispute(d.dispute_id);
  assert.equal(end.status, 'RESOLVED');
  assert.equal(end.dispute_outcome?.outcome_code, 'RESOLVED_WITH_PAYOUT');
  assert.equal(sim.balance, 5050);
});

test('buyer can deny an offer, which returns the case to the seller', async () => {
  const { sim, cap } = await setup();
  const d = sim.createBuyerDispute({ capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' });
  await sim.makeOffer(d.dispute_id, { note: 'n', offer_type: 'REFUND', offer_amount: money(25) });
  sim.buyerDeniesOffer(d.dispute_id);
  const x = await sim.getDispute(d.dispute_id);
  assert.equal(x.status, 'WAITING_FOR_SELLER_RESPONSE');
  assert.equal(x.offer?.buyer_response, 'DENIED');
});

test('accept claim: full refund resolves, partial waits for the buyer, validation rules apply', async () => {
  const { sim, cap } = await setup();
  const a = sim.createBuyerDispute({ capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' });
  await fails(sim.acceptClaim(a.dispute_id, { note: 'n', accept_claim_type: 'REFUND', refund_amount: money(10) }), 'VALIDATION_ERROR', 'AMOUNT_SHOULD_NOT_BE_PASSED');
  await fails(sim.acceptClaim(a.dispute_id, { note: 'n', accept_claim_type: 'PARTIAL_REFUND' }), 'VALIDATION_ERROR', 'MISSING_REFUND_AMOUNT');
  await sim.acceptClaim(a.dispute_id, { note: 'n', accept_claim_type: 'PARTIAL_REFUND', refund_amount: money(30) });
  assert.equal((await sim.getDispute(a.dispute_id)).status, 'WAITING_FOR_BUYER_RESPONSE');
  const b = sim.createBuyerDispute({ capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' });
  await sim.acceptClaim(b.dispute_id, { note: 'n', accept_claim_type: 'REFUND' });
  const end = await sim.getDispute(b.dispute_id);
  assert.equal(end.status, 'RESOLVED');
  assert.equal(end.dispute_outcome?.amount_refunded?.value, '100.00');
});

test('insufficient sandbox balance blocks a refund', async () => {
  const { sim, cap } = await setup({ balance: 0 });
  sim.balance = 10;
  const d = sim.createBuyerDispute({ capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' });
  await fails(sim.acceptClaim(d.dispute_id, { note: 'n', accept_claim_type: 'REFUND' }), 'VALIDATION_ERROR', 'INSUFFICIENT_FUNDS');
});

test('evidence validation mirrors PayPal issue codes', async () => {
  const { sim, cap } = await setup();
  const d = sim.createBuyerDispute({ capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' });
  const id = d.dispute_id;
  await fails(sim.provideEvidence(id, { evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT' }] }), 'VALIDATION_ERROR', 'MISSING_TRACKING_INFO');
  await fails(sim.provideEvidence(id, { evidences: [{ evidence_type: 'PROOF_OF_REFUND' }] }), 'VALIDATION_ERROR', 'MISSING_REFUND_ID');
  await fails(sim.provideEvidence(id, { evidences: [{ evidence_type: '' as any }] }), 'VALIDATION_ERROR', 'MISSING_EVIDENCE_TYPE');
  const note = [{ evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'delivered' }];
  await fails(sim.provideEvidence(id, { evidences: note, files: [{ name: 'a.exe', content_type: 'application/octet-stream', data: new Uint8Array(5) }] }), 'VALIDATION_ERROR', 'INVALID_EVIDENCE_FILE');
  await fails(sim.provideEvidence(id, { evidences: note, files: [{ name: 'big.pdf', content_type: 'application/pdf', data: new Uint8Array(10 * 1024 * 1024) }] }), 'VALIDATION_ERROR', 'INVALID_EVIDENCE_FILE');
  await sim.provideEvidence(id, { evidences: note, files: [{ name: 'ok.pdf', content_type: 'application/pdf', data: new Uint8Array(100) }] });
});

test('actions that are not available return ACTION_NOT_AVAILABLE', async () => {
  const { sim, cap } = await setup();
  const d = sim.createBuyerDispute({ capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' });
  await fails(sim.adjudicate(d.dispute_id, 'SELLER_FAVOR'), 'UNPROCESSABLE_ENTITY', 'ACTION_NOT_AVAILABLE');
  await fails(sim.appeal(d.dispute_id, { evidences: [{ evidence_type: 'OTHER', notes: 'x' }] }), 'UNPROCESSABLE_ENTITY', 'ACTION_NOT_AVAILABLE');
});

test("PayPal's ERRDIS test values return the documented errors", async () => {
  const { sim } = await setup();
  await fails(sim.getDispute('ERRDIS016'), 'INVALID_RESOURCE_ID');
  await fails(sim.getDispute('ERRDIS019'), 'RATE_LIMIT_REACHED');
  await fails(sim.provideEvidence('ERRDIS044', { evidences: [] }), 'VALIDATION_ERROR', 'INVALID_EVIDENCE_FILE');
  await fails(sim.acceptClaim('ERRDIS061', { note: 'n', accept_claim_type: 'REFUND' }), 'VALIDATION_ERROR', 'INSUFFICIENT_FUNDS');
  await fails(sim.acceptClaim('ERRDIS065', { note: 'n', accept_claim_type: 'REFUND' }), 'UNPROCESSABLE_ENTITY');
  assert.equal(errdis('show', 'ERRDIS016')?.status, 404);
  assert.equal(errdis('show', 'PP-R-1'), undefined);
});

test('escalation moves INQUIRY to CHARGEBACK and removes the inquiry-only actions', async () => {
  const { sim, cap } = await setup();
  const d = sim.createBuyerDispute({ capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' });
  assert.deepEqual(d.allowed_response_options?.make_offer?.offer_types.length, 4);
  await sim.escalate(d.dispute_id, 'Escalating for review');
  const x = await sim.getDispute(d.dispute_id);
  assert.equal(x.dispute_life_cycle_stage, 'CHARGEBACK');
  assert.ok(!rels(x).includes('send-message') && !rels(x).includes('escalate'));
});

test('appeal exists only after a buyer-favour result for an appealable case, once', async () => {
  const { sim, cap } = await setup();
  const d = sim.createBuyerDispute({ capture_id: cap, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', allow_appeal: true });
  await sim.provideEvidence(d.dispute_id, { evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'delivered' }] });
  await sim.adjudicate(d.dispute_id, 'BUYER_FAVOR');
  const lost = await sim.getDispute(d.dispute_id);
  assert.ok(rels(lost).includes('appeal'));
  await sim.appeal(d.dispute_id, { evidences: [{ evidence_type: 'OTHER', notes: 'new proof' }] });
  const x = await sim.getDispute(d.dispute_id);
  assert.equal(x.dispute_life_cycle_stage, 'PRE_ARBITRATION');
  assert.equal(x.status, 'UNDER_REVIEW');
  await sim.adjudicate(d.dispute_id, 'BUYER_FAVOR');
  assert.ok(!rels(await sim.getDispute(d.dispute_id)).includes('appeal'));
});

test('multipart builder produces PayPal-style input and file parts', () => {
  const { body, contentType } = buildMultipart([
    { name: 'input', contentType: 'application/json', data: '{"a":1}' },
    { name: 'file1', filename: 'proof.pdf', contentType: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) },
  ], 'BOUND');
  const text = new TextDecoder().decode(body);
  assert.equal(contentType, 'multipart/form-data; boundary=BOUND');
  assert.match(text, /Content-Disposition: form-data; name="input"\r\nContent-Type: application\/json\r\n\r\n\{"a":1\}\r\n/);
  assert.match(text, /name="file1"; filename="proof.pdf"\r\nContent-Type: application\/pdf\r\n\r\n%PDF\r\n--BOUND--\r\n$/);
});
