import type { Dispute, Link, Money, Reason, WebhookEvent } from '../domain/types.ts';
import { PayPalApiError } from './gateway.ts';
import type {
  AcceptClaimInput, AddTrackingInput, CreateOrderInput, Headers, MakeOfferInput, OrderCaptured, OrderCreated,
  PayPalGateway, ProvideEvidenceInput,
} from './gateway.ts';
import { ACCEPTED } from '../engine/evidence.ts';
import { addDays, amt, iso, money, systemClock } from '../util/ids.ts';
import type { Clock } from '../util/ids.ts';

/**
 * A local model of PayPal's Disputes API. Statuses, stages, HATEOAS links, allowed options, error codes
 * and test values follow PayPal's published docs. Transitions that the docs do not spell out (for example what
 * status follows provide-evidence) are best guesses: replace them with recorded sandbox fixtures after spikes S2 and S3.
 */
const GENERIC = ['FORBIDDEN', 'INVALID_RESOURCE_ID', 'NOT_ACCEPTABLE', 'UNSUPPORTED_MEDIA_TYPE', 'RATE_LIMIT_REACHED', 'SERVICE_UNAVAILABLE', 'INTERNAL_SERVICE_ERROR', 'AUTHORIZATION_ERROR', 'UNPROCESSABLE_ENTITY'];
const HTTP: Record<string, number> = { FORBIDDEN: 403, INVALID_RESOURCE_ID: 404, NOT_ACCEPTABLE: 406, UNSUPPORTED_MEDIA_TYPE: 415, RATE_LIMIT_REACHED: 429, SERVICE_UNAVAILABLE: 503, INTERNAL_SERVICE_ERROR: 500, AUTHORIZATION_ERROR: 401, UNPROCESSABLE_ENTITY: 422, VALIDATION_ERROR: 422 };
const EVIDENCE_ISSUES = ['INVALID_EVIDENCE_FILE', 'INVALID_EVIDENCE_TYPE_PROOF_OF_FULFILLMENT', 'ITEM_ID_IS_MANDATORY_FOR_MULTIPLE_EVIDENCES', 'MISSING_EVIDENCE_INFO', 'MISSING_EVIDENCE_TYPE', 'MISSING_REFUND_ID', 'MISSING_TRACKING_INFO'];
const ERRDIS: Record<string, { start: number; generic: number; issues?: string[]; tail?: string }> = {
  show: { start: 15, generic: 8 },
  'provide-evidence': { start: 35, generic: 9, issues: EVIDENCE_ISSUES },
  'accept-claim': { start: 51, generic: 9, tail: 'UNPROCESSABLE_ENTITY', issues: ['AMOUNT_SHOULD_NOT_BE_PASSED', 'INSUFFICIENT_FUNDS', 'INTANGIBLE_ITEM_CANNOT_BE_RETURNED', 'INVALID_RETURN_SHIPPING_ADDRESS_FORMAT', 'MISSING_RETURN_SHIPPING_ADDRESS'] },
  appeal: { start: 66, generic: 9, issues: EVIDENCE_ISSUES },
  escalate: { start: 82, generic: 9 },
  'send-message': { start: 91, generic: 9 },
  'make-offer': { start: 100, generic: 9 },
};

/** PayPal's documented ERRDIS test values: put one in the dispute ID to get a specific error back. */
export function errdis(op: string, id: string): PayPalApiError | undefined {
  const m = /^ERRDIS(\d{3})$/.exec(id);
  const cfg = ERRDIS[op];
  if (!m || !cfg) return undefined;
  const i = Number(m[1]) - cfg.start;
  if (i < 0) return undefined;
  if (i < cfg.generic) return new PayPalApiError(HTTP[GENERIC[i]], GENERIC[i], `Simulated error for test value ${id}`);
  const j = i - cfg.generic;
  if (cfg.issues && j < cfg.issues.length) return new PayPalApiError(422, 'VALIDATION_ERROR', `Simulated validation error for test value ${id}`, [cfg.issues[j]]);
  if (cfg.tail && j === (cfg.issues?.length ?? 0)) return new PayPalApiError(HTTP[cfg.tail], cfg.tail, `Simulated error for test value ${id}`);
  return undefined;
}

export type SimOptions = { clock?: Clock; balance?: number; response_window_days?: number; sink?: (e: WebhookEvent) => unknown };
type Meta = { capture_id: string; appealable: boolean; appealed: boolean };
const ALLOWED_FILE = /\.(jpe?g|gif|png|pdf)$/i;

export class SimulatedPayPal implements PayPalGateway {
  mode = 'SIMULATED' as const;
  clock: Clock;
  balance: number;
  window: number;
  sink?: (e: WebhookEvent) => unknown;
  orders = new Map<string, { id: string; approved: boolean; input: CreateOrderInput; capture_id?: string }>();
  captures = new Map<string, { order_id: string; amount: Money }>();
  trackers: AddTrackingInput[] = [];
  refunds: { id: string; capture_id: string; amount: number }[] = [];
  disputes = new Map<string, Dispute>();
  meta = new Map<string, Meta>();
  events: WebhookEvent[] = [];
  pending: Promise<unknown>[] = [];
  seq = { order: 0, capture: 0, dispute: 0, event: 0, refund: 0 };

  constructor(opts: SimOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.balance = opts.balance ?? 5000;
    this.window = opts.response_window_days ?? 10;
    this.sink = opts.sink;
  }
  /** Wait for all webhook deliveries triggered so far. */
  async settle() { while (this.pending.length) await Promise.allSettled(this.pending.splice(0)); }

  // ---------- orders ----------
  async createOrder(input: CreateOrderInput): Promise<OrderCreated> {
    const id = `SIMORD${String(++this.seq.order).padStart(5, '0')}`;
    this.orders.set(id, { id, approved: false, input });
    return { id, status: 'PAYER_ACTION_REQUIRED', approve_url: `/sim/approve?token=${id}` };
  }
  approveOrder(id: string) { const o = this.orders.get(id); if (!o) throw new PayPalApiError(404, 'INVALID_RESOURCE_ID', 'Order not found'); o.approved = true; }
  async captureOrder(id: string): Promise<OrderCaptured> {
    const o = this.orders.get(id);
    if (!o) throw new PayPalApiError(404, 'INVALID_RESOURCE_ID', `Order ${id} not found`);
    if (!o.approved) throw new PayPalApiError(422, 'UNPROCESSABLE_ENTITY', 'Order not approved by the payer', ['ORDER_NOT_APPROVED']);
    const capture_id = o.capture_id ?? `SIMCAP${String(++this.seq.capture).padStart(5, '0')}`;
    if (!o.capture_id) { o.capture_id = capture_id; this.captures.set(capture_id, { order_id: id, amount: o.input.amount }); this.balance += amt(o.input.amount); }
    return { id, status: 'COMPLETED', capture_id, amount: o.input.amount };
  }
  async addTracking(input: AddTrackingInput) { this.trackers.push({ ...input }); }
  async refundCapture(captureId: string, amount?: Money) {
    const c = this.captures.get(captureId);
    if (!c) throw new PayPalApiError(404, 'INVALID_RESOURCE_ID', 'Capture not found');
    const value = amount ? amt(amount) : amt(c.amount);
    if (value > this.balance) throw new PayPalApiError(422, 'UNPROCESSABLE_ENTITY', 'Insufficient funds', ['INSUFFICIENT_FUNDS']);
    this.balance -= value;
    const id = `SIMRF${String(++this.seq.refund).padStart(5, '0')}`;
    this.refunds.push({ id, capture_id: captureId, amount: value });
    return { id };
  }

  // ---------- buyer side (sandbox UI in the real world; helpers here) ----------
  createBuyerDispute(input: { capture_id: string; reason: Reason; message?: string; amount?: number; allow_appeal?: boolean }): Dispute {
    const cap = this.captures.get(input.capture_id);
    if (!cap) throw new PayPalApiError(404, 'INVALID_RESOURCE_ID', `Capture ${input.capture_id} not found`);
    const now = this.clock();
    const id = `PP-R-SIM-${String(++this.seq.dispute).padStart(5, '0')}`;
    const inquiry = input.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' || input.reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
    const snad = input.reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
    const d: Dispute = {
      dispute_id: id, reason: input.reason, status: 'WAITING_FOR_SELLER_RESPONSE',
      dispute_life_cycle_stage: inquiry ? 'INQUIRY' : 'CHARGEBACK',
      dispute_amount: money(input.amount ?? amt(cap.amount), cap.amount.currency_code),
      disputed_transactions: [{ seller_transaction_id: input.capture_id, buyer_transaction_id: input.capture_id }],
      seller_response_due_date: iso(addDays(now, this.window)),
      evidences: [{ evidence_type: ACCEPTED[input.reason][0], source: 'REQUESTED_FROM_SELLER' }],
      allowed_response_options: {
        make_offer: { offer_types: snad ? ['REFUND', 'REFUND_WITH_RETURN', 'REFUND_WITH_REPLACEMENT', 'REPLACEMENT_WITHOUT_REFUND'] : ['REFUND'] },
        accept_claim: { accept_claim_types: snad ? ['REFUND', 'REFUND_WITH_RETURN', 'PARTIAL_REFUND'] : ['REFUND', 'PARTIAL_REFUND'] },
      },
      messages: input.message ? [{ posted_by: 'BUYER', time_posted: iso(now), content: input.message }] : [],
      create_time: iso(now), update_time: iso(now), links: [],
    };
    this.disputes.set(id, d);
    this.meta.set(id, { capture_id: input.capture_id, appealable: !!input.allow_appeal, appealed: false });
    this.touch(d);
    this.emit('CUSTOMER.DISPUTE.CREATED', d);
    return structuredClone(d);
  }
  buyerAcceptsOffer(id: string) {
    const d = this.raw(id);
    if (d.status !== 'WAITING_FOR_BUYER_RESPONSE' || !d.offer) throw new PayPalApiError(422, 'UNPROCESSABLE_ENTITY', 'No offer awaiting the buyer', ['ACTION_NOT_AVAILABLE']);
    const x = d.offer.seller_offered_amount ? amt(d.offer.seller_offered_amount) : 0;
    this.balance -= x;
    d.offer.buyer_response = 'ACCEPTED';
    d.dispute_outcome = { outcome_code: 'RESOLVED_WITH_PAYOUT', amount_refunded: money(x, d.dispute_amount.currency_code) };
    d.status = 'RESOLVED';
    this.touch(d); this.emit('CUSTOMER.DISPUTE.RESOLVED', d);
  }
  buyerDeniesOffer(id: string) {
    const d = this.raw(id);
    if (!d.offer) throw new PayPalApiError(422, 'UNPROCESSABLE_ENTITY', 'No offer to deny', ['ACTION_NOT_AVAILABLE']);
    d.offer.buyer_response = 'DENIED';
    d.status = 'WAITING_FOR_SELLER_RESPONSE';
    this.touch(d); this.emit('CUSTOMER.DISPUTE.UPDATED', d);
  }
  buyerSendsMessage(id: string, content: string) {
    const d = this.raw(id);
    (d.messages ??= []).push({ posted_by: 'BUYER', time_posted: iso(this.clock()), content });
    this.touch(d); this.emit('CUSTOMER.DISPUTE.UPDATED', d);
  }

  // ---------- disputes API ----------
  async listDisputes(q: { disputed_transaction_id?: string } = {}) {
    return [...this.disputes.values()]
      .filter((d) => !q.disputed_transaction_id || d.disputed_transactions.some((t) => t.seller_transaction_id === q.disputed_transaction_id || t.buyer_transaction_id === q.disputed_transaction_id))
      .map((d) => structuredClone(d));
  }
  async getDispute(id: string) { return structuredClone(this.find(id, 'show')); }

  async provideEvidence(id: string, input: ProvideEvidenceInput) {
    const d = this.find(id, 'provide-evidence');
    this.need(d, 'provide-evidence');
    if (!input.evidences?.length) throw this.validation('MISSING_EVIDENCE_INFO');
    let total = 0;
    for (const f of input.files ?? []) {
      total += f.data.length;
      if (!ALLOWED_FILE.test(f.name) || f.data.length >= 10 * 1024 * 1024) throw this.validation('INVALID_EVIDENCE_FILE');
    }
    if (total > 50 * 1024 * 1024) throw this.validation('INVALID_EVIDENCE_FILE');
    for (const e of input.evidences) {
      if (!e.evidence_type) throw this.validation('MISSING_EVIDENCE_TYPE');
      if (!ACCEPTED[d.reason].includes(e.evidence_type as any)) throw this.validation('MISSING_EVIDENCE_INFO');
      if (e.evidence_type === 'PROOF_OF_FULFILLMENT' && !e.evidence_info?.tracking_info?.length && !e.notes && !e.documents?.length) throw this.validation('MISSING_TRACKING_INFO');
      if (e.evidence_type === 'PROOF_OF_REFUND' && !e.evidence_info?.refund_ids?.length) throw this.validation('MISSING_REFUND_ID');
      if (e.evidence_type === 'OTHER' && !e.notes && !e.documents?.length) throw this.validation('MISSING_EVIDENCE_INFO');
    }
    d.evidences = [
      ...(d.evidences ?? []).filter((e) => e.source !== 'REQUESTED_FROM_SELLER'),
      ...input.evidences.map((e) => ({ evidence_type: e.evidence_type, source: 'SUBMITTED_BY_SELLER', notes: e.notes })),
    ];
    d.status = 'UNDER_REVIEW'; // modelled: PayPal reviews once the seller has responded; confirm with spike S3
    this.touch(d); this.emit('CUSTOMER.DISPUTE.UPDATED', d);
  }
  async makeOffer(id: string, input: MakeOfferInput) {
    const d = this.find(id, 'make-offer');
    this.need(d, 'make-offer');
    if (!d.allowed_response_options?.make_offer?.offer_types.includes(input.offer_type)) throw this.validation('INVALID_OFFER_TYPE');
    if (input.offer_type !== 'REPLACEMENT_WITHOUT_REFUND') {
      const x = input.offer_amount ? amt(input.offer_amount) : 0;
      if (!(x > 0) || x > amt(d.dispute_amount)) throw this.validation('INVALID_OFFER_AMOUNT');
    }
    d.offer = { offer_type: input.offer_type, seller_offered_amount: input.offer_amount };
    (d.messages ??= []).push({ posted_by: 'SELLER', time_posted: iso(this.clock()), content: input.note });
    d.status = 'WAITING_FOR_BUYER_RESPONSE';
    this.touch(d); this.emit('CUSTOMER.DISPUTE.UPDATED', d);
  }
  async acceptClaim(id: string, input: AcceptClaimInput) {
    const d = this.find(id, 'accept-claim');
    this.need(d, 'accept-claim');
    if (!d.allowed_response_options?.accept_claim?.accept_claim_types.includes(input.accept_claim_type)) throw this.validation('INVALID_ACCEPT_CLAIM_TYPE');
    const A = amt(d.dispute_amount);
    if (input.accept_claim_type === 'REFUND' && input.refund_amount) throw this.validation('AMOUNT_SHOULD_NOT_BE_PASSED');
    if (input.accept_claim_type === 'PARTIAL_REFUND' && !input.refund_amount) throw this.validation('MISSING_REFUND_AMOUNT');
    const refund = input.accept_claim_type === 'PARTIAL_REFUND' ? amt(input.refund_amount!) : A;
    if (refund > this.balance) throw this.validation('INSUFFICIENT_FUNDS');
    if (refund < A - 1e-9) {
      // Less than the buyer asked for: PayPal asks the buyer to consent first.
      d.offer = { offer_type: 'PARTIAL_REFUND', seller_offered_amount: money(refund, d.dispute_amount.currency_code) };
      d.status = 'WAITING_FOR_BUYER_RESPONSE';
      this.touch(d); this.emit('CUSTOMER.DISPUTE.UPDATED', d);
      return;
    }
    this.balance -= refund;
    d.dispute_outcome = { outcome_code: 'RESOLVED_BUYER_FAVOUR', amount_refunded: money(refund, d.dispute_amount.currency_code) };
    d.status = 'RESOLVED';
    this.touch(d); this.emit('CUSTOMER.DISPUTE.RESOLVED', d);
  }
  async sendMessage(id: string, message: string) {
    const d = this.find(id, 'send-message');
    this.need(d, 'send-message');
    (d.messages ??= []).push({ posted_by: 'SELLER', time_posted: iso(this.clock()), content: message });
    this.touch(d); this.emit('CUSTOMER.DISPUTE.UPDATED', d); // status stays while PayPal still waits for the seller's evidence
  }
  async escalate(id: string, note: string) {
    const d = this.find(id, 'escalate');
    this.need(d, 'escalate');
    (d.messages ??= []).push({ posted_by: 'SELLER', time_posted: iso(this.clock()), content: note });
    d.dispute_life_cycle_stage = 'CHARGEBACK';
    d.status = 'WAITING_FOR_SELLER_RESPONSE';
    this.touch(d); this.emit('CUSTOMER.DISPUTE.UPDATED', d);
  }
  async appeal(id: string, input: ProvideEvidenceInput) {
    const d = this.find(id, 'appeal');
    this.need(d, 'appeal');
    if (!input.evidences?.length) throw this.validation('MISSING_EVIDENCE_INFO');
    this.meta.get(id)!.appealed = true;
    d.dispute_life_cycle_stage = 'PRE_ARBITRATION';
    d.status = 'UNDER_REVIEW';
    this.touch(d); this.emit('CUSTOMER.DISPUTE.UPDATED', d);
  }
  async adjudicate(id: string, outcome: 'BUYER_FAVOR' | 'SELLER_FAVOR') {
    const d = this.find(id, 'adjudicate');
    this.need(d, 'adjudicate');
    if (outcome === 'BUYER_FAVOR') {
      const A = amt(d.dispute_amount);
      this.balance -= A;
      d.dispute_outcome = { outcome_code: 'RESOLVED_BUYER_FAVOUR', amount_refunded: money(A, d.dispute_amount.currency_code) };
    } else {
      d.dispute_outcome = { outcome_code: 'RESOLVED_SELLER_FAVOUR' };
    }
    d.status = 'RESOLVED';
    this.touch(d); this.emit('CUSTOMER.DISPUTE.RESOLVED', d);
  }
  async requireEvidence(id: string, action: 'BUYER_EVIDENCE' | 'SELLER_EVIDENCE') {
    const d = this.find(id, 'require-evidence');
    this.need(d, 'require-evidence');
    d.status = action === 'SELLER_EVIDENCE' ? 'WAITING_FOR_SELLER_RESPONSE' : 'WAITING_FOR_BUYER_RESPONSE';
    this.touch(d); this.emit('CUSTOMER.DISPUTE.UPDATED', d);
  }
  async verifyWebhook(headers: Headers) { return headers['x-sim-signature'] === 'valid'; }

  // ---------- internals ----------
  private raw(id: string): Dispute {
    const d = this.disputes.get(id);
    if (!d) throw new PayPalApiError(404, 'INVALID_RESOURCE_ID', `Dispute ${id} not found`);
    return d;
  }
  private find(id: string, op: string): Dispute {
    const err = errdis(op, id);
    if (err) throw err;
    return this.raw(id);
  }
  private need(d: Dispute, rel: string) {
    if (!d.links.some((l) => l.rel === rel)) {
      throw new PayPalApiError(422, 'UNPROCESSABLE_ENTITY', `"${rel}" is not available while the dispute is ${d.dispute_life_cycle_stage}/${d.status}`, ['ACTION_NOT_AVAILABLE']);
    }
  }
  private validation(issue: string) { return new PayPalApiError(422, 'VALIDATION_ERROR', `Request failed validation: ${issue}`, [issue]); }
  private touch(d: Dispute) { d.update_time = iso(this.clock()); d.links = this.linksFor(d); }
  private linksFor(d: Dispute): Link[] {
    const m = this.meta.get(d.dispute_id)!;
    const base = `/v1/customer/disputes/${d.dispute_id}`;
    const l = (rel: string): Link => ({ href: `${base}/${rel}`, rel, method: 'POST' });
    const out: Link[] = [{ href: base, rel: 'self', method: 'GET' }];
    if (d.status === 'WAITING_FOR_SELLER_RESPONSE') {
      out.push(l('provide-evidence'), l('accept-claim'), l('make-offer'));
      if (d.dispute_life_cycle_stage === 'INQUIRY') out.push(l('send-message'), l('escalate'));
    }
    if (d.status === 'UNDER_REVIEW') out.push(l('provide-supporting-info'), l('adjudicate'), l('require-evidence'));
    if (d.status === 'RESOLVED' && d.dispute_outcome?.outcome_code === 'RESOLVED_BUYER_FAVOUR' && m.appealable && !m.appealed) out.push(l('appeal'));
    return out;
  }
  private emit(type: string, d: Dispute) {
    const e: WebhookEvent = {
      id: `WH-SIM-${String(++this.seq.event).padStart(5, '0')}`, event_type: type, create_time: iso(this.clock()), resource_type: 'dispute',
      summary: `A dispute was ${type.split('.').pop()!.toLowerCase()}`,
      resource: { dispute_id: d.dispute_id, status: d.status, reason: d.reason, dispute_life_cycle_stage: d.dispute_life_cycle_stage, dispute_amount: d.dispute_amount, disputed_transactions: d.disputed_transactions },
    };
    this.events.push(e);
    if (this.sink) this.pending.push(Promise.resolve(this.sink(e)));
  }
}
