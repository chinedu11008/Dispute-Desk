import type { ActionProposal } from '../domain/analysis.ts';
import type { PayPalGateway } from '../paypal/gateway.ts';
import { PayPalApiError } from '../paypal/gateway.ts';
import { validateProposal } from '../policy/policy.ts';
import type { PolicyConfig } from '../policy/policy.ts';
import { toExhibits } from '../agent/citations.ts';
import type { AuditLog } from '../audit/audit.ts';
import { iso } from '../util/ids.ts';
import type { Clock } from '../util/ids.ts';

export type ExecResult = { proposal_id: string; ok: boolean; at: string; error?: string; debug_id?: string; violations?: { code: string; detail: string }[] };

/** The only code path that writes to PayPal. It re-validates, executes once per idempotency key, and logs everything. */
export class Executor {
  gateway: PayPalGateway;
  audit: AuditLog;
  clock: Clock;
  policy: PolicyConfig;
  done = new Map<string, ExecResult>();
  constructor(gateway: PayPalGateway, audit: AuditLog, clock: Clock, policy: PolicyConfig = {}) {
    this.gateway = gateway; this.audit = audit; this.clock = clock; this.policy = policy;
  }

  async execute(p: ActionProposal, ctx: { dispute_id: string; vault_ids: Set<string>; approver: string }): Promise<ExecResult> {
    const prior = this.done.get(p.idempotency_key);
    if (prior) { this.audit.append('system', 'ACTION_DEDUPED', { proposal: p.id, key: p.idempotency_key }, p.case_id); return prior; }

    const at = iso(this.clock());
    const dispute = await this.gateway.getDispute(ctx.dispute_id);
    const check = validateProposal(p, { dispute, vault_ids: ctx.vault_ids, now: this.clock(), config: this.policy });
    if (!check.ok) {
      this.audit.append('system', 'ACTION_BLOCKED', { proposal: p.id, violations: check.violations }, p.case_id);
      return { proposal_id: p.id, ok: false, at, error: 'Blocked by policy', violations: check.violations };
    }
    this.audit.append('user', 'ACTION_APPROVED', { proposal: p.id, type: p.type, approver: ctx.approver, params: p.params }, p.case_id);
    try {
      await this.dispatch(p, ctx.dispute_id);
      const res: ExecResult = { proposal_id: p.id, ok: true, at };
      this.done.set(p.idempotency_key, res);
      this.audit.append('system', 'ACTION_EXECUTED', { proposal: p.id, type: p.type }, p.case_id);
      return res;
    } catch (e) {
      const err = e as Partial<PayPalApiError> & Error;
      this.audit.append('system', 'ACTION_FAILED', { proposal: p.id, type: p.type, error: err.message, code: err.code, debug_id: err.debug_id }, p.case_id);
      return { proposal_id: p.id, ok: false, at, error: err.message, debug_id: err.debug_id };
    }
  }

  private async dispatch(p: ActionProposal, id: string) {
    const x = p.params;
    switch (p.type) {
      case 'PROVIDE_EVIDENCE':
        return this.gateway.provideEvidence(id, { evidences: [{ evidence_type: x.evidence_type, evidence_info: x.evidence_info, notes: toExhibits(x.notes ?? '') }] });
      case 'MAKE_OFFER':
        return this.gateway.makeOffer(id, { note: toExhibits(x.note ?? ''), offer_type: x.offer_type, offer_amount: x.offer_amount });
      case 'ACCEPT_CLAIM':
        return this.gateway.acceptClaim(id, { note: toExhibits(x.note ?? ''), accept_claim_type: x.accept_claim_type, refund_amount: x.refund_amount });
      case 'SEND_MESSAGE':
        return this.gateway.sendMessage(id, toExhibits(x.message ?? ''));
      case 'ESCALATE':
        return this.gateway.escalate(id, toExhibits(x.note ?? 'Escalating for review'));
      case 'APPEAL':
        return this.gateway.appeal(id, { evidences: [{ evidence_type: x.evidence_type, evidence_info: x.evidence_info, notes: toExhibits(x.notes ?? '') }] });
    }
  }
}
