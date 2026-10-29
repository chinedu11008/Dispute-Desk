import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../src/vault/vault.ts';
import { AuditLog } from '../src/audit/audit.ts';
import { checkCitations, toExhibits } from '../src/agent/citations.ts';
import { assess, addressMatches, bucketOf } from '../src/engine/evidence.ts';
import { Priors, priceOptions, recommend, qAccept } from '../src/engine/decision.ts';
import { validateProposal } from '../src/policy/policy.ts';
import { manualClock, money } from '../src/util/ids.ts';
import type { Dispute, Order } from '../src/domain/types.ts';

const order: Order = {
  id: 'ord_1', paypal_order_id: 'O-1', capture_id: 'CAP-1', sku: 'pack', title: 'Daypack', amount: money(100),
  ship_to: { line1: '12 Elm Street', city: 'Austin', postal_code: '78701', country_code: 'US' }, status: 'DELIVERED', created_at: '2026-10-01T00:00:00Z',
};
const dispute = (over: Partial<Dispute> = {}): Dispute => ({
  dispute_id: 'PP-R-1', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE',
  dispute_life_cycle_stage: 'INQUIRY', dispute_amount: money(100), disputed_transactions: [{ seller_transaction_id: 'CAP-1' }],
  seller_response_due_date: '2026-10-22T00:00:00Z', create_time: '2026-10-12T09:00:00Z', update_time: '2026-10-12T09:00:00Z',
  allowed_response_options: { make_offer: { offer_types: ['REFUND'] }, accept_claim: { accept_claim_types: ['REFUND', 'PARTIAL_REFUND'] } },
  links: ['provide-evidence', 'make-offer', 'accept-claim', 'send-message', 'escalate'].map((rel) => ({ href: `/x/${rel}`, rel, method: 'POST' })),
  ...over,
});

function strongVault() {
  const v = new Vault(manualClock());
  v.add({ transaction_id: 'CAP-1', kind: 'ORDER_RECEIPT', source: 'store', summary: 'Order for Daypack, $100.00' });
  v.add({ transaction_id: 'CAP-1', kind: 'TRACKING', source: 'store', summary: 'UPS 1Z999 delivered', payload: {
    carrier: 'UPS', tracking_number: '1Z999', status: 'DELIVERED', delivered_at: '2026-10-08T15:00:00Z',
    delivered_to: { line1: '12 Elm St', postal_code: '78701' }, verified: true } });
  v.add({ transaction_id: 'CAP-1', kind: 'DELIVERY_PROOF', source: 'carrier', summary: 'Photo of parcel at door' });
  v.add({ transaction_id: 'CAP-1', kind: 'MESSAGE', source: 'store', summary: 'Buyer emailed on Oct 10' });
  return v;
}

test('vault is append-only with stable ids and hashes', () => {
  const v = strongVault();
  assert.equal(v.items[0].id, 'EV-0001');
  assert.equal(v.forTransaction('CAP-1').length, 4);
  assert.match(v.items[0].sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => { (v.items[0] as any).summary = 'tampered'; });
});

test('audit log chains hashes and detects tampering', () => {
  const log = new AuditLog(manualClock());
  log.append('system', 'A', { n: 1 }, 'c1');
  log.append('agent', 'B', { n: 2 }, 'c1');
  log.append('user', 'C', { n: 3 });
  assert.deepEqual(log.verify(), { ok: true });
  log.entries[1].data = { n: 99 };
  assert.deepEqual(log.verify(), { ok: false, broken_at: 2 });
});

test('citation checker flags uncited and unknown citations, exempts pleasantries', () => {
  const allowed = new Set(['EV-0001', 'EV-0002']);
  const ok = checkCitations('The parcel was delivered on October 8 [EV-0002]. Thank you for your patience.', allowed);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.cited, ['EV-0002']);
  const bad = checkCitations('The parcel was delivered on October 8 and signed for by the buyer.', allowed);
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].reason, 'UNCITED');
  const unknown = checkCitations('The parcel was delivered on October 8 [EV-0099].', allowed);
  assert.equal(unknown.violations[0].reason, 'UNKNOWN_CITATION');
  assert.equal(toExhibits('Delivered [EV-0002].'), 'Delivered (Exhibit EV-0002).');
});

test('address matching compares postal code and street number', () => {
  assert.equal(addressMatches(order.ship_to, { line1: '12 Elm St.', postal_code: '78701' }), true);
  assert.equal(addressMatches(order.ship_to, { line1: '99 Elm St', postal_code: '78701' }), false);
  assert.equal(addressMatches(order.ship_to, { line1: '12 Elm St', postal_code: '10001' }), false);
});

test('INR with full proof scores strong; missing delivery scores weak', () => {
  const v = strongVault();
  const a = assess({ dispute: dispute(), order, items: v.forTransaction('CAP-1') });
  assert.equal(a.strength, 1);
  assert.equal(a.bucket, 'strong');
  assert.deepEqual(a.accepted_evidence_types, ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND']);

  const weak = new Vault(manualClock());
  weak.add({ transaction_id: 'CAP-1', kind: 'ORDER_RECEIPT', source: 'store', summary: 'Order' });
  weak.add({ transaction_id: 'CAP-1', kind: 'TRACKING', source: 'store', summary: 'Shipped only', payload: { carrier: 'UPS', tracking_number: '1Z', status: 'SHIPPED' } });
  const w = assess({ dispute: dispute(), order, items: weak.forTransaction('CAP-1') });
  assert.equal(w.bucket, 'weak');
  assert.ok(w.gaps.includes('Carrier reports delivery'));
});

test('late delivery and wrong address fail the matching checks', () => {
  const v = new Vault(manualClock());
  v.add({ transaction_id: 'CAP-1', kind: 'TRACKING', source: 'store', summary: 'late', payload: {
    carrier: 'UPS', tracking_number: '1Z', status: 'DELIVERED', delivered_at: '2026-10-13T00:00:00Z', delivered_to: { line1: '99 Oak', postal_code: '10001' } } });
  const a = assess({ dispute: dispute(), order, items: v.forTransaction('CAP-1') });
  const by = Object.fromEntries(a.checks.map((c) => [c.id, c.passed]));
  assert.equal(by.delivered_before_dispute, false);
  assert.equal(by.address_match, false);
  assert.equal(by.carrier_delivered, true);
});

test('SNAD scoring uses listing, policy and complaint terms', () => {
  const v = new Vault(manualClock());
  v.add({ transaction_id: 'CAP-1', kind: 'PRODUCT_SNAPSHOT', source: 'store', summary: 'Listing: color navy, 30L, water-resistant' });
  v.add({ transaction_id: 'CAP-1', kind: 'POLICY_SNAPSHOT', source: 'store', summary: '30-day returns', payload: { accepted_at_checkout: true } });
  const facts = { buyer_claim_summary: '', allegations: [], complaint_terms: ['navy', 'waterproof'], requested_outcome: 'REFUND' as const, contradictions: [], injection_attempt_detected: false };
  const a = assess({ dispute: dispute({ reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' }), order, items: v.forTransaction('CAP-1'), facts });
  assert.equal(a.strength, 0.65);
  assert.equal(a.bucket, 'strong');
  assert.deepEqual(a.accepted_evidence_types, ['OTHER', 'PROOF_OF_REFUND']);
});

test('bucket boundaries', () => {
  assert.equal(bucketOf(0.34), 'weak');
  assert.equal(bucketOf(0.35), 'moderate');
  assert.equal(bucketOf(0.65), 'strong');
});

const allowed = { can_fight: true, offer_types: ['REFUND'], accept_types: ['REFUND', 'PARTIAL_REFUND'] };

test('expected-loss formulas match the design doc', () => {
  const priors = new Priors();
  const opts = priceOptions({ amount: 100, currency: 'USD', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', bucket: 'strong', allowed, priors });
  const p = (8 + 1) / (10 + 2);
  const fight = opts.find((o) => o.kind === 'FIGHT')!;
  assert.equal(fight.expected_loss, Math.round((1 - p) * 115 * 100) / 100);
  assert.equal(opts.find((o) => o.kind === 'ACCEPT')!.expected_loss, 100);
  const offer = opts.find((o) => o.kind === 'OFFER')!;
  const q = qAccept(offer.params.offer_amount.value / 100, undefined, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
  const expected = q * Number(offer.params.offer_amount.value) + (1 - q) * (1 - p) * 115;
  assert.ok(Math.abs(offer.expected_loss - expected) < 0.011);
});

test('strong evidence recommends fighting; weak evidence recommends a partial offer', () => {
  const priors = new Priors();
  const strong = priceOptions({ amount: 100, currency: 'USD', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', bucket: 'strong', allowed, priors });
  assert.equal(recommend(strong, 100).recommended.kind, 'FIGHT');
  const weak = priceOptions({ amount: 100, currency: 'USD', reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', bucket: 'weak', allowed, priors });
  const rec = recommend(weak, 100);
  assert.equal(rec.recommended.kind, 'OFFER');
  assert.equal(rec.recommended.params.offer_amount.value, '50.00');
});

test('a buyer who received nothing is unlikely to take a small partial refund', () => {
  assert.ok(qAccept(0.5, undefined, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') < 0.05);
  assert.ok(qAccept(0.5, undefined, 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') >= 0.5);
});

test('without an offer path, weak evidence falls back to accepting', () => {
  const opts = priceOptions({ amount: 100, currency: 'USD', reason: 'OTHER', bucket: 'weak', allowed: { can_fight: true, offer_types: [], accept_types: ['REFUND'] }, priors: new Priors() });
  assert.equal(recommend(opts, 100).recommended.kind, 'ACCEPT');
});

test('priors learn from outcomes and report sample size', () => {
  const priors = new Priors();
  const before = priors.stats('X', 'strong');
  assert.equal(before.n, 0);
  for (let i = 0; i < 10; i++) priors.record('X', 'strong', false);
  const after = priors.stats('X', 'strong');
  assert.equal(after.n, 10);
  assert.ok(after.p < before.p);
});

test('policy engine blocks unavailable actions, bad amounts and uncited text', () => {
  const d = dispute();
  const ctx = { dispute: d, vault_ids: new Set(['EV-0001']), now: new Date('2026-10-13T00:00:00Z') };
  const base = { id: 'p1', case_id: 'c1', expected_loss: 1, idempotency_key: 'k', summary: '', evidence_refs: ['EV-0001'] };
  const ok = validateProposal({ ...base, type: 'PROVIDE_EVIDENCE', params: { evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z' }] }, notes: 'Shipped with UPS and delivered on October 8 [EV-0001].' } }, ctx);
  assert.equal(ok.ok, true);
  const noLink = validateProposal({ ...base, type: 'APPEAL', params: {} }, ctx);
  assert.equal(noLink.violations[0].code, 'ACTION_NOT_AVAILABLE');
  const big = validateProposal({ ...base, type: 'MAKE_OFFER', params: { offer_type: 'REFUND', offer_amount: money(150) } }, ctx);
  assert.ok(big.violations.some((x) => x.code === 'AMOUNT_EXCEEDS_LIMIT'));
  const uncited = validateProposal({ ...base, type: 'PROVIDE_EVIDENCE', params: { evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'The buyer signed for the parcel and accepted delivery.' } }, ctx);
  assert.ok(uncited.violations.some((x) => x.code === 'UNCITED_CLAIM'));
  const wrongType = validateProposal({ ...base, type: 'PROVIDE_EVIDENCE', params: { evidence_type: 'OTHER', notes: 'x' } }, ctx);
  assert.ok(wrongType.violations.some((x) => x.code === 'EVIDENCE_TYPE_NOT_ACCEPTED'));
  const late = validateProposal({ ...base, type: 'ACCEPT_CLAIM', params: { accept_claim_type: 'REFUND' } }, { ...ctx, now: new Date('2026-11-01T00:00:00Z') });
  assert.ok(late.violations.some((x) => x.code === 'DEADLINE_PASSED'));
});
