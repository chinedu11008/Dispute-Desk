import type { ActionProposal, CaseAnalysis, Outcome } from '../domain/analysis.ts';
import type { Dispute, WebhookEvent } from '../domain/types.ts';
import type { Headers, PayPalGateway } from '../paypal/gateway.ts';
import type { Vault } from '../vault/vault.ts';
import type { AuditLog } from '../audit/audit.ts';
import type { LLM } from '../agent/llm.ts';
import type { Config, Priors } from '../engine/decision.ts';
import type { PolicyConfig } from '../policy/policy.ts';
import type { OrderBook } from '../store/orders.ts';
import { Executor } from '../exec/executor.ts';
import type { ExecResult } from '../exec/executor.ts';
import { analyze } from '../agent/pipeline.ts';
import { validateProposal } from '../policy/policy.ts';
import { amt, iso, money, rid, sha256 } from '../util/ids.ts';
import type { Clock } from '../util/ids.ts';

export type CaseState = 'NEW' | 'TRIAGED' | 'ASSESSED' | 'AWAITING_APPROVAL' | 'EXECUTING' | 'WAITING' | 'RESOLVED' | 'OUTCOME_RECORDED' | 'CLOSED' | 'ACTION_FAILED';
const NEXT: Record<CaseState, CaseState[]> = {
  NEW: ['TRIAGED', 'ACTION_FAILED'],
  TRIAGED: ['ASSESSED'],
  ASSESSED: ['AWAITING_APPROVAL'],
  AWAITING_APPROVAL: ['EXECUTING', 'RESOLVED'],
  EXECUTING: ['WAITING', 'ACTION_FAILED', 'AWAITING_APPROVAL', 'RESOLVED'],
  WAITING: ['AWAITING_APPROVAL', 'RESOLVED'],
  ACTION_FAILED: ['AWAITING_APPROVAL', 'EXECUTING', 'RESOLVED'],
  RESOLVED: ['OUTCOME_RECORDED'],
  OUTCOME_RECORDED: ['CLOSED'],
  CLOSED: [],
};

export type Case = {
  id: string; dispute_id: string; transaction_id: string; order_id?: string; state: CaseState;
  created_at: string; updated_at: string; dispute: Dispute; analysis?: CaseAnalysis;
  approvals: Record<string, { approver: string; at: string }>;
  rejected: Record<string, { approver: string; reason: string; at: string }>;
  executed: Record<string, ExecResult>;
  outcome?: Outcome; first_response_at?: string;
};
export type CaseDeps = {
  gateway: PayPalGateway; vault: Vault; audit: AuditLog; llm: LLM; priors: Priors;
  config: Partial<Config>; policy: PolicyConfig; clock: Clock; orders: OrderBook;
};

export class CaseManager {
  deps: CaseDeps;
  executor: Executor;
  cases = new Map<string, Case>();
  byDispute = new Map<string, string>();
  seen = new Set<string>();
  locks = new Map<string, Promise<void>>();

  constructor(deps: CaseDeps) {
    this.deps = deps;
    this.executor = new Executor(deps.gateway, deps.audit, deps.clock, deps.policy);
  }
  get(id: string) { const c = this.cases.get(id); if (!c) throw new Error(`Unknown case ${id}`); return c; }
  list() { return [...this.cases.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)); }

  // ---- serialised per dispute so webhooks and approvals never interleave ----
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.locks.set(key, prev.then(() => mine));
    await prev;
    try { return await fn(); } finally { release(); }
  }
  private transition(c: Case, to: CaseState) {
    if (c.state === to) return;
    if (!NEXT[c.state].includes(to)) throw new Error(`Illegal case transition ${c.state} -> ${to}`);
    this.deps.audit.append('system', 'CASE_STATE', { from: c.state, to }, c.id);
    c.state = to; c.updated_at = iso(this.deps.clock());
  }

  // ---- webhook entry ----
  async handleWebhook(req: { headers: Headers; rawBody: string }): Promise<{ status: 'processed' | 'duplicate' | 'rejected' | 'error'; reason?: string }> {
    const { audit, gateway } = this.deps;
    if (!(await gateway.verifyWebhook(req.headers, req.rawBody))) { audit.append('system', 'WEBHOOK_REJECTED', { reason: 'signature' }); return { status: 'rejected', reason: 'signature' }; }
    let event: WebhookEvent;
    try { event = JSON.parse(req.rawBody); } catch { audit.append('system', 'WEBHOOK_REJECTED', { reason: 'bad json' }); return { status: 'rejected', reason: 'bad json' }; }
    if (this.seen.has(event.id)) { audit.append('system', 'WEBHOOK_DUPLICATE', { id: event.id }); return { status: 'duplicate' }; }
    this.seen.add(event.id);
    audit.append('paypal', 'WEBHOOK_RECEIVED', { id: event.id, type: event.event_type, dispute: event.resource?.dispute_id });
    const id = event.resource?.dispute_id;
    if (!id) return { status: 'processed' };
    try {
      await this.locked(id, async () => {
        if (event.event_type === 'CUSTOMER.DISPUTE.CREATED') await this.ingest(id);
        else if (event.event_type === 'CUSTOMER.DISPUTE.UPDATED') await this.sync(id);
        else if (event.event_type === 'CUSTOMER.DISPUTE.RESOLVED') await this.resolve(id);
      });
      return { status: 'processed' };
    } catch (e) {
      audit.append('system', 'WEBHOOK_ERROR', { id: event.id, error: (e as Error).message });
      return { status: 'error', reason: (e as Error).message };
    }
  }

  // ---- internals (call only while holding the dispute lock) ----
  private async ingest(disputeId: string): Promise<void> {
    if (this.byDispute.has(disputeId)) return this.sync(disputeId);
    const { gateway, orders, audit, clock } = this.deps;
    const dispute = await gateway.getDispute(disputeId);
    const tx = dispute.disputed_transactions[0].seller_transaction_id;
    const c: Case = {
      id: rid('case'), dispute_id: disputeId, transaction_id: tx, order_id: orders.byCapture(tx)?.id, state: 'NEW',
      created_at: iso(clock()), updated_at: iso(clock()), dispute, approvals: {}, rejected: {}, executed: {},
    };
    this.cases.set(c.id, c); this.byDispute.set(disputeId, c.id);
    audit.append('system', 'CASE_OPENED', { dispute: disputeId, reason: dispute.reason, amount: dispute.dispute_amount }, c.id);
    await this.runAnalysis(c);
  }

  private async runAnalysis(c: Case) {
    const { vault, orders, audit } = this.deps;
    c.analysis = await analyze(this.deps, { case_id: c.id, dispute: c.dispute, order: c.order_id ? orders.get(c.order_id) : undefined, items: vault.forTransaction(c.transaction_id) });
    const a = c.analysis;
    audit.append('agent', 'ANALYSIS_COMPLETE', { llm: a.llm, strength: a.assessment.strength, bucket: a.assessment.bucket, recommendation: a.recommendation.kind, flags: a.risk_flags }, c.id);
    if (c.state === 'NEW') { this.transition(c, 'TRIAGED'); this.transition(c, 'ASSESSED'); }
    this.transition(c, 'AWAITING_APPROVAL');
  }

  private async sync(disputeId: string): Promise<void> {
    const id = this.byDispute.get(disputeId);
    if (!id) return this.ingest(disputeId);
    const c = this.get(id);
    c.dispute = await this.deps.gateway.getDispute(disputeId);
    if (c.dispute.status === 'RESOLVED') return this.resolve(disputeId);
    if (c.state === 'WAITING' && c.dispute.status === 'WAITING_FOR_SELLER_RESPONSE') await this.runAnalysis(c); // e.g. the buyer turned down our offer
  }

  private async resolve(disputeId: string) {
    const id = this.byDispute.get(disputeId);
    if (!id) return;
    const c = this.get(id);
    if (c.outcome) return;
    const d = await this.deps.gateway.getDispute(disputeId);
    c.dispute = d;
    if (d.status !== 'RESOLVED') return;
    const A = amt(d.dispute_amount);
    const cur = d.dispute_amount.currency_code;
    const code = d.dispute_outcome?.outcome_code ?? '';
    const refunded = d.dispute_outcome?.amount_refunded ? amt(d.dispute_outcome.amount_refunded) : 0;
    const fought = (d.evidences ?? []).some((e) => e.source === 'SUBMITTED_BY_SELLER') ||
      Object.entries(c.executed).some(([pid, r]) => r.ok && c.analysis?.proposals.find((p) => p.id === pid)?.type === 'PROVIDE_EVIDENCE');
    const fee = this.deps.config.dispute_fee ?? 15;
    let o: Omit<Outcome, 'resolved_at' | 'amount' | 'fought'>;
    if (code === 'RESOLVED_SELLER_FAVOUR') o = { result: 'WON', recovered: A, lost: 0, fees: 0 };
    else if (code === 'RESOLVED_BUYER_FAVOUR') o = fought ? { result: 'LOST', recovered: 0, lost: refunded || A, fees: fee } : { result: 'ACCEPTED', recovered: 0, lost: refunded || A, fees: 0 };
    else if (code === 'CANCELED_BY_BUYER') o = { result: 'CANCELED', recovered: A, lost: 0, fees: 0 };
    else o = { result: 'SETTLED', recovered: Math.max(0, A - refunded), lost: refunded, fees: 0 };
    c.outcome = { ...o, fought, resolved_at: iso(this.deps.clock()), amount: money(A, cur) };
    if (fought && c.analysis) this.deps.priors.record(c.dispute.reason, c.analysis.assessment.bucket, o.result === 'WON');
    this.deps.audit.append('system', 'OUTCOME_RECORDED', c.outcome, c.id);
    this.transition(c, 'RESOLVED'); this.transition(c, 'OUTCOME_RECORDED'); this.transition(c, 'CLOSED');
  }

  // ---- human decisions ----
  async approve(caseId: string, proposalId: string, approver: string, edits?: { notes?: string; note?: string; message?: string }): Promise<Case> {
    const c = this.get(caseId);
    return this.locked(c.dispute_id, async () => {
      if (!['AWAITING_APPROVAL', 'ACTION_FAILED'].includes(c.state)) throw new Error(`Case is ${c.state}; nothing to approve`);
      const i = c.analysis?.proposals.findIndex((p) => p.id === proposalId) ?? -1;
      if (!c.analysis || i < 0) throw new Error(`Unknown proposal ${proposalId}`);
      let p: ActionProposal = c.analysis.proposals[i];
      if (edits && Object.keys(edits).length) {
        p = { ...p, params: { ...p.params, ...edits } };
        p.idempotency_key = sha256([c.id, p.type, JSON.stringify(p.params)].join('|')).slice(0, 32);
        c.analysis.proposals[i] = p;
        this.deps.audit.append('user', 'PROPOSAL_EDITED', { proposal: p.id, fields: Object.keys(edits), approver }, c.id);
      }
      this.transition(c, 'EXECUTING');
      const res = await this.executor.execute(p, { dispute_id: c.dispute_id, vault_ids: this.deps.vault.ids(c.transaction_id), approver });
      c.executed[p.id] = res;
      if (res.ok) {
        c.approvals[p.id] = { approver, at: res.at };
        c.first_response_at ??= res.at;
        c.dispute = await this.deps.gateway.getDispute(c.dispute_id);
        if (c.dispute.status === 'RESOLVED') await this.resolve(c.dispute_id);
        else if (c.state === 'EXECUTING') this.transition(c, 'WAITING');
      } else if (c.state === 'EXECUTING') {
        this.transition(c, res.violations ? 'AWAITING_APPROVAL' : 'ACTION_FAILED');
      }
      return c;
    });
  }

  /** Dry run: would this proposal, with these edits, pass policy right now? Changes nothing. */
  check(caseId: string, proposalId: string, edits?: { notes?: string; note?: string; message?: string }) {
    const c = this.get(caseId);
    const p0 = c.analysis?.proposals.find((x) => x.id === proposalId);
    if (!p0) throw new Error(`Unknown proposal ${proposalId}`);
    const p: ActionProposal = edits ? { ...p0, params: { ...p0.params, ...edits } } : p0;
    return validateProposal(p, { dispute: c.dispute, vault_ids: this.deps.vault.ids(c.transaction_id), now: this.deps.clock(), config: this.deps.policy });
  }

  async reject(caseId: string, proposalId: string, approver: string, reason: string): Promise<Case> {
    const c = this.get(caseId);
    c.rejected[proposalId] = { approver, reason, at: iso(this.deps.clock()) };
    this.deps.audit.append('user', 'PROPOSAL_REJECTED', { proposal: proposalId, approver, reason }, c.id);
    return c;
  }

  kpis() {
    const all = this.list();
    const done = all.filter((c) => c.outcome);
    const sum = (f: (o: Outcome) => number) => Math.round(done.reduce((n, c) => n + f(c.outcome!), 0) * 100) / 100;
    const fought = done.filter((c) => c.outcome!.fought);
    const mins = all.filter((c) => c.first_response_at).map((c) => (new Date(c.first_response_at!).getTime() - new Date(c.created_at).getTime()) / 60_000).sort((a, b) => a - b);
    return {
      cases: all.length, open: all.length - done.length, resolved: done.length,
      recovered: sum((o) => o.recovered), lost: sum((o) => o.lost), fees: sum((o) => o.fees),
      fought: fought.length, won: fought.filter((c) => c.outcome!.result === 'WON').length,
      win_rate: fought.length ? fought.filter((c) => c.outcome!.result === 'WON').length / fought.length : null,
      median_minutes_to_respond: mins.length ? mins[Math.floor(mins.length / 2)] : null,
    };
  }
}
