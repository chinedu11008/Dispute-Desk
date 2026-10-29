// Runs the whole loop offline: order -> evidence -> dispute -> analysis -> approval -> PayPal -> outcome.
//   npm run demo                 all scenarios
//   npm run demo -- inr-weak     one scenario
import { buildContext } from '../src/app.ts';
import { SCENARIOS, seedScenario } from '../src/store/scenarios.ts';
import type { ScenarioName } from '../src/store/scenarios.ts';

const pick = process.argv[2] as ScenarioName | undefined;
const names = pick ? [pick] : [...SCENARIOS];
if (pick && !SCENARIOS.includes(pick)) { console.error(`Unknown scenario. Choose one of: ${SCENARIOS.join(', ')}`); process.exit(1); }

const ctx = buildContext({});
const sim = ctx.sim!;
const bar = (s: string) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const usd = (n: number) => `$${n.toFixed(2)}`;

for (const name of names) {
  bar(`Scenario: ${name}`);
  const { dispute } = await seedScenario(name, { sim, orders: ctx.orders, clock: ctx.clock });
  const c = ctx.cases.list().find((x) => x.dispute_id === dispute.dispute_id)!;
  const a = c.analysis!;
  console.log(`${c.order_id ? ctx.orders.get(c.order_id).title : ''}  |  ${dispute.reason.replace('MERCHANDISE_OR_SERVICE_', '')}  |  ${usd(Number(dispute.dispute_amount.value))}  |  due ${dispute.seller_response_due_date?.slice(0, 10)}`);
  console.log(`Buyer says: "${dispute.messages?.[0]?.content}"`);
  if (a.risk_flags.length) console.log(`Flags: ${a.risk_flags.join(', ')}`);

  console.log(`\nEvidence strength ${Math.round(a.assessment.strength * 100)}% (${a.assessment.bucket})`);
  for (const k of a.assessment.checks) console.log(`  ${k.passed ? '[x]' : '[ ]'} ${k.label.padEnd(46)} ${k.evidence_ids.join(' ')}`);

  console.log('\nOptions (expected loss, lower is better)');
  for (const o of a.options) {
    const mark = o.kind === a.recommendation.kind && o.label === a.recommendation.label ? '>>' : '  ';
    console.log(`${mark} ${usd(o.expected_loss).padStart(8)}  ${o.label}`);
    console.log(`              ${o.rationale}`);
  }
  for (const n of a.recommendation_notes) console.log(`   note: ${n}`);

  const p = a.proposals[0];
  console.log(`\nProposed action: ${p.type} - ${p.summary}`);
  const text = p.params.notes ?? p.params.note;
  if (text) console.log(text.split('\n').map((l: string) => `   | ${l}`).join('\n'));
  console.log(`Review: ${a.review.approved ? 'passed (every factual sentence cites stored evidence)' : 'BLOCKED ' + JSON.stringify(a.review.violations)}`);

  await ctx.cases.approve(c.id, p.id, 'merchant@example.com');
  console.log(`\nApproved and sent to PayPal. Dispute is now ${c.dispute.status}.`);
  if (c.dispute.status === 'UNDER_REVIEW') { await sim.adjudicate(c.dispute_id, 'SELLER_FAVOR'); console.log('Sandbox adjudication: SELLER_FAVOR'); }
  else if (c.dispute.status === 'WAITING_FOR_BUYER_RESPONSE') { sim.buyerAcceptsOffer(c.dispute_id); console.log('Buyer accepted the offer.'); }
  await sim.settle();
  const o = c.outcome!;
  console.log(`Outcome: ${o.result}  recovered ${usd(o.recovered)}  lost ${usd(o.lost)}  fees ${usd(o.fees)}`);
}

const k = ctx.cases.kpis();
bar('KPIs');
console.log(`cases ${k.cases}  resolved ${k.resolved}  recovered ${usd(k.recovered)}  lost ${usd(k.lost)}  fees ${usd(k.fees)}  win rate ${k.win_rate === null ? 'n/a' : Math.round(k.win_rate * 100) + '%'}`);
console.log(`audit chain intact: ${ctx.audit.verify().ok}  (${ctx.audit.entries.length} entries)`);
