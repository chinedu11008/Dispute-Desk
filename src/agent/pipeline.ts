import type { Dispute, EvidenceItem, Order } from '../domain/types.ts';
import type { ActionProposal, CaseAnalysis, Drafts, PricedOption } from '../domain/analysis.ts';
import type { LLM } from './llm.ts';
import { citationsIn, checkCitations } from './citations.ts';
import { assess } from '../engine/evidence.ts';
import { priceOptions, recommend } from '../engine/decision.ts';
import type { Config, Priors } from '../engine/decision.ts';
import { canDo } from '../policy/policy.ts';
import { amt, iso, rid, sha256 } from '../util/ids.ts';
import type { Clock } from '../util/ids.ts';

export type PipelineDeps = { llm: LLM; priors: Priors; config: Partial<Config>; clock: Clock };

/** triage -> assess -> price options -> draft -> review -> typed proposals. Nothing here talks to PayPal. */
export async function analyze(deps: PipelineDeps, args: { case_id: string; dispute: Dispute; order?: Order; items: EvidenceItem[] }): Promise<CaseAnalysis> {
  const { dispute, order, items } = args;
  const facts = await deps.llm.triage({ dispute, order });
  const assessment = assess({ dispute, order, items, facts });
  const A = amt(dispute.dispute_amount);
  const allowed = {
    can_fight: canDo(dispute, 'PROVIDE_EVIDENCE'),
    // Once the buyer has turned an offer down, do not offer again: fight or accept.
    offer_types: dispute.offer?.buyer_response === 'DENIED' ? [] : dispute.allowed_response_options?.make_offer?.offer_types ?? [],
    accept_types: dispute.allowed_response_options?.accept_claim?.accept_claim_types ?? [],
  };
  const options = priceOptions({ amount: A, currency: dispute.dispute_amount.currency_code, reason: dispute.reason, bucket: assessment.bucket, allowed, priors: deps.priors, config: deps.config });
  const { recommended, notes } = recommend(options, A, deps.config);
  const drafts = await deps.llm.draft({ dispute, order, option: recommended, items, assessment, facts });
  const ids = new Set(items.map((i) => i.id));
  const text = [drafts.evidence_note, drafts.buyer_message, drafts.offer_note ?? ''].join('\n');
  const cit = checkCitations(text, ids);
  const rev = await deps.llm.review({ drafts, items, dispute });
  const approved = rev.approved && cit.ok;

  const risk_flags: string[] = [];
  if (facts.injection_attempt_detected) risk_flags.push('PROMPT_INJECTION_ATTEMPT');
  if (assessment.gaps.length) risk_flags.push('EVIDENCE_GAPS');
  if (!approved) risk_flags.push('DRAFT_BLOCKED');
  if (dispute.seller_response_due_date && new Date(dispute.seller_response_due_date).getTime() - deps.clock().getTime() < 48 * 3_600_000) risk_flags.push('DEADLINE_SOON');

  return {
    facts, assessment, options, recommendation: recommended, recommendation_notes: notes, drafts,
    review: { ...rev, approved, citation_ok: cit.ok, violations: cit.violations.map((v) => ({ sentence: v.sentence, reason: v.reason })) },
    proposals: buildProposals(args.case_id, recommended, drafts, dispute, items),
    risk_flags, llm: deps.llm.name, ran_at: iso(deps.clock()),
  };
}

export function buildProposals(caseId: string, rec: PricedOption, drafts: Drafts, dispute: Dispute, items: EvidenceItem[]): ActionProposal[] {
  const mk = (type: ActionProposal['type'], params: Record<string, any>, refs: string[], summary: string): ActionProposal => ({
    id: rid('prop'), case_id: caseId, type, params, evidence_refs: refs, expected_loss: rec.expected_loss, summary,
    idempotency_key: sha256([caseId, type, JSON.stringify(params)].join('|')).slice(0, 32),
  });
  const out: ActionProposal[] = [];
  if (rec.kind === 'FIGHT') {
    const tr = items.filter((i) => i.kind === 'TRACKING').at(-1);
    const fulfilment = dispute.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' || dispute.reason === 'UNAUTHORISED';
    const params: Record<string, any> = { evidence_type: fulfilment ? 'PROOF_OF_FULFILLMENT' : 'OTHER', notes: drafts.evidence_note };
    if (fulfilment && tr) params.evidence_info = { tracking_info: [{ carrier_name: tr.payload.carrier, tracking_number: tr.payload.tracking_number }] };
    out.push(mk('PROVIDE_EVIDENCE', params, citationsIn(drafts.evidence_note), `Submit ${fulfilment ? 'proof of fulfilment' : 'supporting evidence'} to PayPal`));
  } else if (rec.kind === 'OFFER') {
    out.push(mk('MAKE_OFFER', { ...rec.params, note: drafts.offer_note ?? drafts.buyer_message }, [], rec.label));
  } else {
    out.push(mk('ACCEPT_CLAIM', { ...rec.params, note: 'We accept the claim and will refund the full amount.' }, [], rec.label));
  }
  return out;
}
