import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../src/app.ts';
import type { AppContext } from '../src/app.ts';
import { seedScenario } from '../src/store/scenarios.ts';
import type { ScenarioName } from '../src/store/scenarios.ts';
import { manualClock } from '../src/util/ids.ts';

async function run(name: ScenarioName) {
  const ctx = buildContext({}, { clock: manualClock() });
  const { dispute } = await seedScenario(name, { sim: ctx.sim!, orders: ctx.orders, clock: ctx.clock });
  const c = ctx.cases.list().find((x) => x.dispute_id === dispute.dispute_id)!;
  return { ctx, c, sim: ctx.sim! };
}
const only = (ctx: AppContext) => ctx.cases.list()[0];

test('strong INR evidence: analysis recommends fighting and drafts a cited note', async () => {
  const { c } = await run('inr-strong');
  assert.equal(c.state, 'AWAITING_APPROVAL');
  const a = c.analysis!;
  assert.equal(a.assessment.bucket, 'strong');
  assert.equal(a.recommendation.kind, 'FIGHT');
  assert.equal(a.review.approved, true);
  assert.equal(a.proposals.length, 1);
  assert.equal(a.proposals[0].type, 'PROVIDE_EVIDENCE');
  assert.equal(a.proposals[0].params.evidence_type, 'PROOF_OF_FULFILLMENT');
  assert.match(a.drafts.evidence_note, /\[EV-\d{4}\]/);
  assert.ok(a.proposals[0].evidence_refs.length >= 3);
  assert.equal(a.llm, 'heuristic');
});

test('fight to a win: approval submits evidence, adjudication records the outcome and teaches the priors', async () => {
  const { ctx, c, sim } = await run('inr-strong');
  const p = c.analysis!.proposals[0];
  const before = ctx.priors.stats(c.dispute.reason, 'strong');
  await ctx.cases.approve(c.id, p.id, 'merchant@example.com');
  await sim.settle();
  assert.equal(c.state, 'WAITING');
  const submitted = (await sim.getDispute(c.dispute_id)).evidences!.find((e) => e.source === 'SUBMITTED_BY_SELLER')!;
  assert.match(submitted.notes!, /\(Exhibit EV-\d{4}\)/);
  assert.doesNotMatch(submitted.notes!, /\[EV-/);

  await sim.adjudicate(c.dispute_id, 'SELLER_FAVOR');
  await sim.settle();
  assert.equal(c.state, 'CLOSED');
  assert.equal(c.outcome!.result, 'WON');
  assert.equal(c.outcome!.recovered, 100);
  const k = ctx.cases.kpis();
  assert.equal(k.recovered, 100);
  assert.equal(k.win_rate, 1);
  assert.equal(ctx.priors.stats(c.dispute.reason, 'strong').n, 1);
  assert.ok(ctx.priors.stats(c.dispute.reason, 'strong').p > before.p);
  assert.deepEqual(ctx.audit.verify(), { ok: true });
  const events = ctx.audit.forCase(c.id).map((e) => e.event);
  for (const e of ['CASE_OPENED', 'ANALYSIS_COMPLETE', 'ACTION_APPROVED', 'ACTION_EXECUTED', 'OUTCOME_RECORDED']) assert.ok(events.includes(e), e);
});

test('fight to a loss costs the amount plus the fee', async () => {
  const { ctx, c, sim } = await run('inr-strong');
  await ctx.cases.approve(c.id, c.analysis!.proposals[0].id, 'm');
  await sim.adjudicate(c.dispute_id, 'BUYER_FAVOR');
  await sim.settle();
  assert.equal(c.outcome!.result, 'LOST');
  assert.equal(c.outcome!.lost, 100);
  assert.equal(c.outcome!.fees, 15);
  assert.equal(ctx.cases.kpis().win_rate, 0);
});

test('weak INR evidence: recommends a partial offer, buyer accepts, outcome is a settlement', async () => {
  const { ctx, c, sim } = await run('inr-weak');
  const a = c.analysis!;
  assert.equal(a.assessment.bucket, 'weak');
  assert.equal(a.recommendation.kind, 'OFFER');
  assert.equal(a.proposals[0].type, 'MAKE_OFFER');
  assert.equal(a.proposals[0].params.offer_amount.value, '45.00');
  await ctx.cases.approve(c.id, a.proposals[0].id, 'm');
  assert.equal((await sim.getDispute(c.dispute_id)).status, 'WAITING_FOR_BUYER_RESPONSE');
  sim.buyerAcceptsOffer(c.dispute_id);
  await sim.settle();
  assert.equal(c.outcome!.result, 'SETTLED');
  assert.equal(c.outcome!.recovered, 15);
  assert.equal(c.outcome!.lost, 45);
  assert.equal(ctx.priors.stats(c.dispute.reason, 'weak').n, 0); // only fights teach the priors
});

test('a denied offer reopens the case and the agent no longer offers', async () => {
  const { ctx, c, sim } = await run('inr-weak');
  await ctx.cases.approve(c.id, c.analysis!.proposals[0].id, 'm');
  sim.buyerDeniesOffer(c.dispute_id);
  await sim.settle();
  assert.equal(c.state, 'AWAITING_APPROVAL');
  assert.notEqual(c.analysis!.recommendation.kind, 'OFFER');
  assert.equal(c.analysis!.recommendation.kind, 'ACCEPT');
});

test('low-value dispute with weak evidence: accept, because the fee outweighs the odds', async () => {
  const { ctx, c, sim } = await run('inr-low-value');
  assert.equal(c.analysis!.recommendation.kind, 'ACCEPT');
  await ctx.cases.approve(c.id, c.analysis!.proposals[0].id, 'm');
  await sim.settle();
  assert.equal(c.outcome!.result, 'ACCEPTED');
  assert.equal(c.outcome!.lost, 12);
  assert.equal(c.outcome!.fees, 0);
});

test('SNAD with a clear listing is defended with OTHER evidence', async () => {
  const { c } = await run('snad');
  const a = c.analysis!;
  assert.equal(c.dispute.reason, 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED');
  assert.equal(a.recommendation.kind, 'FIGHT');
  assert.equal(a.proposals[0].params.evidence_type, 'OTHER');
  assert.match(a.drafts.evidence_note, /not waterproof/);
});

test('prompt injection in the buyer message is flagged and never influences the money decision', async () => {
  const { c } = await run('inr-injection');
  const a = c.analysis!;
  assert.ok(a.risk_flags.includes('PROMPT_INJECTION_ATTEMPT'));
  assert.equal(a.facts.injection_attempt_detected, true);
  assert.equal(a.recommendation.kind, 'FIGHT');
  const all = JSON.stringify([a.drafts, a.proposals]);
  assert.doesNotMatch(all, /\$500|500/);
});

test('duplicate and unsigned webhooks are ignored', async () => {
  const { ctx } = await run('inr-strong');
  const ev = ctx.sim!.events[0];
  const dup = await ctx.cases.handleWebhook({ headers: { 'x-sim-signature': 'valid' }, rawBody: JSON.stringify(ev) });
  assert.equal(dup.status, 'duplicate');
  const bad = await ctx.cases.handleWebhook({ headers: {}, rawBody: JSON.stringify({ ...ev, id: 'WH-NEW' }) });
  assert.equal(bad.status, 'rejected');
  assert.equal(ctx.cases.list().length, 1);
});

test('approving twice executes once', async () => {
  const { ctx, c, sim } = await run('inr-strong');
  const p = c.analysis!.proposals[0];
  let calls = 0;
  const orig = sim.provideEvidence.bind(sim);
  sim.provideEvidence = async (...args: Parameters<typeof orig>) => { calls++; return orig(...args); };
  await ctx.cases.approve(c.id, p.id, 'm');
  await assert.rejects(ctx.cases.approve(c.id, p.id, 'm'), /nothing to approve/);
  const second = await ctx.cases.executor.execute(p, { dispute_id: c.dispute_id, vault_ids: ctx.vault.ids(c.transaction_id), approver: 'm' });
  assert.equal(second.ok, true);
  assert.equal(calls, 1);
});

test('an edit that adds an uncited claim is blocked before anything reaches PayPal', async () => {
  const { ctx, c, sim } = await run('inr-strong');
  const p = c.analysis!.proposals[0];
  const original = p.params.notes as string;
  await ctx.cases.approve(c.id, p.id, 'm', { notes: 'The buyer personally signed for the parcel and confirmed receipt by phone.' });
  assert.equal(c.state, 'AWAITING_APPROVAL');
  const events = ctx.audit.forCase(c.id).map((e) => e.event);
  assert.ok(events.includes('PROPOSAL_EDITED') && events.includes('ACTION_BLOCKED'));
  assert.equal((await sim.getDispute(c.dispute_id)).status, 'WAITING_FOR_SELLER_RESPONSE');
  // a compliant edit goes through
  const p2 = c.analysis!.proposals[0];
  await ctx.cases.approve(c.id, p2.id, 'm', { notes: original });
  assert.equal(c.state, 'WAITING');
});

test('a PayPal failure lands in ACTION_FAILED and can be retried', async () => {
  const { ctx, c, sim } = await run('inr-weak');
  const p = c.analysis!.proposals[0];
  const orig = sim.makeOffer.bind(sim);
  let fail = true;
  sim.makeOffer = async (...args: Parameters<typeof orig>) => { if (fail) { fail = false; throw Object.assign(new Error('boom'), { code: 'SERVICE_UNAVAILABLE' }); } return orig(...args); };
  await ctx.cases.approve(c.id, p.id, 'm');
  assert.equal(c.state, 'ACTION_FAILED');
  await ctx.cases.approve(c.id, p.id, 'm');
  assert.equal(c.state, 'WAITING');
});

test('KPIs aggregate across cases', async () => {
  const ctx = buildContext({}, { clock: manualClock() });
  const deps = { sim: ctx.sim!, orders: ctx.orders, clock: ctx.clock };
  const a = (await seedScenario('inr-strong', deps)).dispute;
  const b = (await seedScenario('inr-low-value', deps)).dispute;
  for (const c of ctx.cases.list()) await ctx.cases.approve(c.id, c.analysis!.proposals[0].id, 'm');
  await ctx.sim!.adjudicate(a.dispute_id, 'SELLER_FAVOR');
  await ctx.sim!.settle();
  const k = ctx.cases.kpis();
  assert.equal(k.cases, 2);
  assert.equal(k.resolved, 2);
  assert.equal(k.recovered, 100);
  assert.equal(k.lost, 12);
  assert.equal(k.won, 1);
  assert.equal(b.dispute_id.startsWith('PP-R-SIM'), true);
  assert.equal(only(ctx) !== undefined, true);
});
