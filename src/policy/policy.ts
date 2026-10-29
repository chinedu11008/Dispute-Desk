import type { ActionProposal, ActionType } from '../domain/analysis.ts';
import type { Dispute } from '../domain/types.ts';
import { ACCEPTED } from '../engine/evidence.ts';
import { checkCitations } from '../agent/citations.ts';
import { amt } from '../util/ids.ts';

/** HATEOAS relation PayPal returns when an action is currently available on a dispute. */
export const RELS: Record<ActionType, string> = {
  PROVIDE_EVIDENCE: 'provide-evidence', MAKE_OFFER: 'make-offer', ACCEPT_CLAIM: 'accept-claim',
  SEND_MESSAGE: 'send-message', ESCALATE: 'escalate', APPEAL: 'appeal',
};
export const canDo = (d: Dispute, type: ActionType): boolean => d.links.some((l) => l.rel === RELS[type]);

export type PolicyConfig = { max_refund?: number };
export type Violation = { code: string; detail: string };

/** Every proposal passes through here before a human can approve it, and again before execution. */
export function validateProposal(
  p: ActionProposal,
  ctx: { dispute: Dispute; vault_ids: Set<string>; now: Date; config?: PolicyConfig },
): { ok: boolean; violations: Violation[] } {
  const v: Violation[] = [];
  const d = ctx.dispute;
  const A = amt(d.dispute_amount);
  const cap = Math.min(A, ctx.config?.max_refund ?? A);

  if (!canDo(d, p.type)) v.push({ code: 'ACTION_NOT_AVAILABLE', detail: `PayPal does not currently offer "${RELS[p.type]}" on this dispute (${d.dispute_life_cycle_stage}/${d.status}).` });
  if (d.seller_response_due_date && new Date(d.seller_response_due_date) < ctx.now) v.push({ code: 'DEADLINE_PASSED', detail: `Response was due ${d.seller_response_due_date}.` });
  for (const id of p.evidence_refs) if (!ctx.vault_ids.has(id)) v.push({ code: 'UNKNOWN_EVIDENCE_REF', detail: `${id} is not in the vault for this transaction.` });

  if (p.type === 'PROVIDE_EVIDENCE') {
    const t = p.params.evidence_type;
    if (!ACCEPTED[d.reason].includes(t)) v.push({ code: 'EVIDENCE_TYPE_NOT_ACCEPTED', detail: `${t} is not accepted for ${d.reason}.` });
    if (t === 'PROOF_OF_FULFILLMENT' && !p.params.evidence_info?.tracking_info?.length && !p.params.notes) v.push({ code: 'MISSING_TRACKING_INFO', detail: 'Fulfilment proof needs a carrier and tracking number, or notes.' });
  }
  if (p.type === 'MAKE_OFFER') {
    if (!d.allowed_response_options?.make_offer?.offer_types.includes(p.params.offer_type)) v.push({ code: 'OFFER_TYPE_NOT_ALLOWED', detail: `${p.params.offer_type} is not an allowed offer type here.` });
    if (p.params.offer_amount && Number(p.params.offer_amount.value) > cap + 1e-9) v.push({ code: 'AMOUNT_EXCEEDS_LIMIT', detail: `Offer ${p.params.offer_amount.value} exceeds ${cap.toFixed(2)}.` });
  }
  if (p.type === 'ACCEPT_CLAIM') {
    if (!d.allowed_response_options?.accept_claim?.accept_claim_types.includes(p.params.accept_claim_type)) v.push({ code: 'ACCEPT_TYPE_NOT_ALLOWED', detail: `${p.params.accept_claim_type} is not an allowed accept type here.` });
    if (p.params.refund_amount && Number(p.params.refund_amount.value) > cap + 1e-9) v.push({ code: 'AMOUNT_EXCEEDS_LIMIT', detail: `Refund ${p.params.refund_amount.value} exceeds ${cap.toFixed(2)}.` });
  }
  for (const field of ['notes', 'note', 'message'] as const) {
    const text = p.params[field];
    if (typeof text !== 'string') continue;
    const c = checkCitations(text, ctx.vault_ids);
    for (const x of c.violations) v.push({ code: x.reason === 'UNCITED' ? 'UNCITED_CLAIM' : 'UNKNOWN_CITATION', detail: x.sentence });
  }
  return { ok: v.length === 0, violations: v };
}
