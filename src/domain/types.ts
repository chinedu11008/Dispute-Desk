export type Money = { currency_code: string; value: string };

export type Reason =
  | 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' | 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' | 'UNAUTHORISED'
  | 'CREDIT_NOT_PROCESSED' | 'DUPLICATE_TRANSACTION' | 'INCORRECT_AMOUNT' | 'PAYMENT_BY_OTHER_MEANS'
  | 'CANCELED_RECURRING_BILLING' | 'OTHER';
export type Stage = 'INQUIRY' | 'CHARGEBACK' | 'PRE_ARBITRATION' | 'ARBITRATION';
export type Status = 'OPEN' | 'WAITING_FOR_SELLER_RESPONSE' | 'WAITING_FOR_BUYER_RESPONSE' | 'UNDER_REVIEW' | 'RESOLVED';
export type EvidenceType = 'PROOF_OF_FULFILLMENT' | 'PROOF_OF_REFUND' | 'OTHER';
export type Link = { href: string; rel: string; method?: string };

/** Subset of PayPal's Disputes API dispute object that Dispute Desk reads. Field names match the API. */
export type Dispute = {
  dispute_id: string;
  reason: Reason;
  status: Status;
  dispute_life_cycle_stage: Stage;
  dispute_amount: Money;
  disputed_transactions: { seller_transaction_id: string; buyer_transaction_id?: string }[];
  seller_response_due_date?: string;
  evidences?: { evidence_type: string; source: string; notes?: string }[];
  allowed_response_options?: {
    make_offer?: { offer_types: string[] };
    accept_claim?: { accept_claim_types: string[] };
  };
  messages?: { posted_by: 'BUYER' | 'SELLER'; time_posted: string; content: string }[];
  offer?: { offer_type: string; seller_offered_amount?: Money; buyer_response?: 'ACCEPTED' | 'DENIED' };
  dispute_outcome?: { outcome_code: string; amount_refunded?: Money };
  create_time: string;
  update_time: string;
  links: Link[];
};

export type WebhookEvent = {
  id: string;
  event_type: string;
  create_time: string;
  resource_type?: string;
  resource: Record<string, any>;
  summary?: string;
};

export type Address = { name?: string; line1: string; city: string; state?: string; postal_code: string; country_code: string };

export type Order = {
  id: string;
  paypal_order_id: string;
  capture_id?: string;
  sku: string;
  title: string;
  amount: Money;
  ship_to: Address;
  status: 'CREATED' | 'CAPTURED' | 'SHIPPED' | 'DELIVERED';
  created_at: string;
};

export type EvidenceKind =
  | 'ORDER_RECEIPT' | 'PRODUCT_SNAPSHOT' | 'POLICY_SNAPSHOT' | 'TRACKING' | 'DELIVERY_PROOF'
  | 'MESSAGE' | 'REFUND' | 'PACKING_RECORD';

export type EvidenceItem = {
  id: string;
  transaction_id: string;
  kind: EvidenceKind;
  source: string;
  captured_at: string;
  summary: string;
  payload: Record<string, any>;
  sha256: string;
};

export type Bucket = 'weak' | 'moderate' | 'strong';
