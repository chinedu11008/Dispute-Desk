import type { Address, Dispute, Money, WebhookEvent } from '../domain/types.ts';

export class PayPalApiError extends Error {
  status: number;
  code: string;
  issues: string[];
  debug_id?: string;
  constructor(status: number, code: string, message: string, issues: string[] = [], debug_id?: string) {
    super(`${code}${issues.length ? ` (${issues.join(', ')})` : ''}: ${message}`);
    this.status = status; this.code = code; this.issues = issues; this.debug_id = debug_id;
  }
}

export type CreateOrderInput = {
  reference_id: string; custom_id?: string; amount: Money; description?: string;
  ship_to: Address; return_url: string; cancel_url: string;
};
export type OrderCreated = { id: string; status: string; approve_url: string };
export type OrderCaptured = { id: string; status: string; capture_id: string; amount: Money };
export type AddTrackingInput = {
  transaction_id: string; tracking_number: string; carrier: string; status: 'SHIPPED' | 'DELIVERED' | 'ON_HOLD' | 'CANCELLED';
};
export type EvidenceFile = { name: string; content_type: string; data: Uint8Array };
export type EvidenceInput = {
  evidence_type: string;
  evidence_info?: { tracking_info?: { carrier_name: string; tracking_number: string }[]; refund_ids?: string[] };
  notes?: string;
  documents?: { name: string }[];
};
export type ProvideEvidenceInput = { evidences: EvidenceInput[]; files?: EvidenceFile[] };
export type MakeOfferInput = { note: string; offer_amount?: Money; offer_type: string; return_shipping_address?: Address };
export type AcceptClaimInput = { note: string; accept_claim_type: string; refund_amount?: Money };
export type Headers = Record<string, string | string[] | undefined>;

/**
 * Everything Dispute Desk needs from PayPal, behind one interface.
 * LivePayPal talks to the sandbox; SimulatedPayPal is a local state machine modelled on PayPal's docs.
 */
export interface PayPalGateway {
  readonly mode: 'SIMULATED' | 'LIVE_SANDBOX';
  createOrder(input: CreateOrderInput): Promise<OrderCreated>;
  captureOrder(orderId: string): Promise<OrderCaptured>;
  addTracking(input: AddTrackingInput): Promise<void>;
  refundCapture(captureId: string, amount?: Money): Promise<{ id: string }>;
  listDisputes(q?: { disputed_transaction_id?: string }): Promise<Dispute[]>;
  getDispute(id: string): Promise<Dispute>;
  provideEvidence(id: string, input: ProvideEvidenceInput): Promise<void>;
  makeOffer(id: string, input: MakeOfferInput): Promise<void>;
  acceptClaim(id: string, input: AcceptClaimInput): Promise<void>;
  sendMessage(id: string, message: string): Promise<void>;
  escalate(id: string, note: string): Promise<void>;
  appeal(id: string, input: ProvideEvidenceInput): Promise<void>;
  /** Sandbox-only helpers that mimic PayPal's own staff. */
  adjudicate(id: string, outcome: 'BUYER_FAVOR' | 'SELLER_FAVOR'): Promise<void>;
  requireEvidence(id: string, action: 'BUYER_EVIDENCE' | 'SELLER_EVIDENCE'): Promise<void>;
  verifyWebhook(headers: Headers, rawBody: string): Promise<boolean>;
}
export type { WebhookEvent };
