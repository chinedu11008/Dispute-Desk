import type { Address, Bucket, Dispute, EvidenceItem, EvidenceKind, EvidenceType, Order, Reason } from '../domain/types.ts';
import type { Assessment, CaseFacts, Check } from '../domain/analysis.ts';

/** From PayPal's "Dispute reasons and evidence" reference. */
export const ACCEPTED: Record<Reason, EvidenceType[]> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND'],
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: ['OTHER', 'PROOF_OF_REFUND'],
  UNAUTHORISED: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'],
  CREDIT_NOT_PROCESSED: ['PROOF_OF_REFUND', 'OTHER'],
  DUPLICATE_TRANSACTION: ['PROOF_OF_REFUND', 'OTHER'],
  INCORRECT_AMOUNT: ['PROOF_OF_REFUND', 'OTHER'],
  PAYMENT_BY_OTHER_MEANS: ['PROOF_OF_REFUND', 'OTHER'],
  CANCELED_RECURRING_BILLING: ['PROOF_OF_REFUND', 'OTHER'],
  OTHER: ['PROOF_OF_REFUND', 'OTHER'],
};

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export function addressMatches(a?: Address, b?: Partial<Address>): boolean {
  if (!a || !b) return false;
  const pc = (x?: string) => norm(x).replace(/ /g, '');
  const num = (x?: string) => norm(x).split(' ')[0];
  return pc(a.postal_code) !== '' && pc(a.postal_code) === pc(b.postal_code) && num(a.line1) === num(b.line1);
}
export const bucketOf = (strength: number): Bucket => (strength < 0.35 ? 'weak' : strength < 0.65 ? 'moderate' : 'strong');

const latest = (items: EvidenceItem[], kind: EvidenceKind) => items.filter((i) => i.kind === kind).at(-1);
const check = (id: string, label: string, weight: number, passed: boolean, detail: string, ev: (EvidenceItem | undefined)[] = []): Check =>
  ({ id, label, weight, passed, detail, evidence_ids: ev.filter(Boolean).map((e) => e!.id) });

/** Scores the vault against what PayPal accepts for this dispute reason. Weights are starter values; tune with evals. */
export function assess(input: { dispute: Dispute; order?: Order; items: EvidenceItem[]; facts?: CaseFacts }): Assessment {
  const { dispute, order, items, facts } = input;
  const reason = dispute.reason;
  const tr = latest(items, 'TRACKING');
  const proof = latest(items, 'DELIVERY_PROOF');
  const snap = latest(items, 'PRODUCT_SNAPSHOT');
  const policy = latest(items, 'POLICY_SNAPSHOT');
  const msg = latest(items, 'MESSAGE');
  const receipt = latest(items, 'ORDER_RECEIPT');
  let checks: Check[];

  if (reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') {
    const delivered = tr?.payload.status === 'DELIVERED';
    const asserted = tr && !tr.payload.verified ? ' (merchant-asserted, not carrier-verified)' : '';
    checks = [
      check('tracking_present', 'Carrier and tracking number on file', 0.25, !!(tr?.payload.carrier && tr?.payload.tracking_number),
        tr ? `${tr.payload.carrier} ${tr.payload.tracking_number}` : 'No tracking item in the vault', [tr]),
      check('carrier_delivered', 'Carrier reports delivery', 0.25, delivered,
        delivered ? `Status DELIVERED${asserted}` : `Latest status: ${tr?.payload.status ?? 'none'}`, [tr]),
      check('delivered_before_dispute', 'Delivered before the dispute opened', 0.15,
        delivered && !!tr?.payload.delivered_at && new Date(tr.payload.delivered_at) <= new Date(dispute.create_time),
        delivered ? `Delivered ${tr?.payload.delivered_at}; dispute opened ${dispute.create_time}` : 'Not delivered', [tr]),
      check('address_match', 'Delivery address matches the order', 0.2,
        delivered && addressMatches(order?.ship_to, tr?.payload.delivered_to),
        delivered ? 'Compared postal code and street number' : 'No delivery address recorded', [tr, receipt]),
      check('signature_or_photo', 'Signature or photo proof of delivery', 0.1, !!proof,
        proof ? proof.summary : 'No delivery proof item', [proof]),
      check('buyer_contact_logged', 'Buyer contact is logged', 0.05, !!msg, msg ? msg.summary : 'No messages logged', [msg]),
    ];
  } else if (reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') {
    const text = norm(`${snap?.summary ?? ''} ${JSON.stringify(snap?.payload ?? {})}`);
    const terms = (facts?.complaint_terms ?? []).map(norm).filter(Boolean);
    const hit = terms.filter((t) => text.includes(t));
    const packing = latest(items, 'PACKING_RECORD') ?? proof;
    const offered = items.filter((i) => i.kind === 'MESSAGE').find((i) => i.payload.offered_remedy);
    checks = [
      check('listing_snapshot', 'Listing captured at purchase', 0.25, !!snap, snap ? snap.summary : 'No product snapshot', [snap]),
      check('return_policy_accepted', 'Return policy accepted at checkout', 0.15, policy?.payload.accepted_at_checkout === true,
        policy ? policy.summary : 'No policy snapshot', [policy]),
      check('complaint_answered', 'Listing states the facts the buyer disputes', 0.25, hit.length > 0,
        hit.length ? `Listing mentions: ${hit.join(', ')} (keyword match; confirm by reading)` : 'No complaint terms found in the listing', [snap]),
      check('packing_record', 'Packing or inspection record', 0.2, !!packing, packing ? packing.summary : 'No packing record', [packing]),
      check('remedy_offered', 'A remedy was already offered', 0.1, !!offered, offered ? offered.summary : 'No remedy logged', [offered]),
      check('comms_log', 'Communications are logged', 0.05, !!msg, msg ? msg.summary : 'No messages logged', [msg]),
    ];
  } else {
    const delivered = tr?.payload.status === 'DELIVERED';
    checks = [
      check('order_receipt', 'Order receipt on file', 0.4, !!receipt, receipt ? receipt.summary : 'No receipt', [receipt]),
      check('fulfilment_proof', 'Fulfilment or delivery proof', 0.4, delivered || !!proof, delivered ? 'Tracking shows delivered' : proof ? proof.summary : 'None', [tr, proof]),
      check('comms_log', 'Communications are logged', 0.2, !!msg, msg ? msg.summary : 'No messages logged', [msg]),
    ];
  }

  const total = checks.reduce((n, c) => n + c.weight, 0);
  const strength = Math.round((checks.filter((c) => c.passed).reduce((n, c) => n + c.weight, 0) / total) * 100) / 100;
  return {
    reason, checks, strength, bucket: bucketOf(strength),
    gaps: checks.filter((c) => !c.passed).map((c) => c.label),
    accepted_evidence_types: ACCEPTED[reason],
  };
}
