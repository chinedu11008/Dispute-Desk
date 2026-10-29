import type { Bucket, EvidenceType, Money, Reason } from './types.ts';

export type CaseFacts = {
  buyer_claim_summary: string;
  allegations: string[];
  complaint_terms: string[];
  requested_outcome: 'REFUND' | 'REPLACEMENT' | 'UNKNOWN';
  contradictions: string[];
  injection_attempt_detected: boolean;
};

export type Check = { id: string; label: string; weight: number; passed: boolean; detail: string; evidence_ids: string[] };
export type Assessment = {
  reason: Reason;
  checks: Check[];
  strength: number;
  bucket: Bucket;
  gaps: string[];
  accepted_evidence_types: EvidenceType[];
};

export type OptionKind = 'FIGHT' | 'OFFER' | 'ACCEPT';
export type PricedOption = {
  kind: OptionKind;
  label: string;
  params: Record<string, any>;
  expected_loss: number;
  expected_recovered: number;
  p_win: number;
  q_accept?: number;
  n_observed: number;
  assumed: boolean;
  rationale: string;
};

export type Drafts = { evidence_note: string; buyer_message: string; offer_note?: string };
export type ReviewResult = {
  approved: boolean;
  unsupported_claims: { sentence: string; reason: string }[];
  tone_issues: string[];
};

export type ActionType = 'PROVIDE_EVIDENCE' | 'MAKE_OFFER' | 'ACCEPT_CLAIM' | 'SEND_MESSAGE' | 'ESCALATE' | 'APPEAL';
export type ActionProposal = {
  id: string;
  case_id: string;
  type: ActionType;
  params: Record<string, any>;
  evidence_refs: string[];
  expected_loss: number;
  idempotency_key: string;
  summary: string;
};

export type CaseAnalysis = {
  facts: CaseFacts;
  assessment: Assessment;
  options: PricedOption[];
  recommendation: PricedOption;
  recommendation_notes: string[];
  drafts: Drafts;
  review: ReviewResult & { citation_ok: boolean; violations: { sentence: string; reason: string }[] };
  proposals: ActionProposal[];
  risk_flags: string[];
  llm: string;
  ran_at: string;
};

export type Outcome = {
  result: 'WON' | 'LOST' | 'SETTLED' | 'ACCEPTED' | 'CANCELED';
  recovered: number;
  lost: number;
  fees: number;
  fought: boolean;
  resolved_at: string;
  amount: Money;
};
