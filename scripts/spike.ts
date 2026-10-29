// Sandbox spike helper. Answers the Week 1 questions in docs/SPIKES.md against PayPal's real sandbox.
//   node scripts/spike.ts <command> [args]        (needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env)
import { mkdirSync, writeFileSync } from 'node:fs';
import { LivePayPal } from '../src/paypal/live.ts';
import { loadEnv } from '../src/util/env.ts';
import { money } from '../src/util/ids.ts';
import { PayPalApiError } from '../src/paypal/gateway.ts';

loadEnv();
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret, PAYPAL_BASE_URL, PUBLIC_BASE_URL = 'http://localhost:3000' } = process.env;
if (!id || !secret) { console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (sandbox app credentials).'); process.exit(1); }
const pp = new LivePayPal({ clientId: id, secret, baseUrl: PAYPAL_BASE_URL, webhookId: process.env.PAYPAL_WEBHOOK_ID });
const [cmd, ...a] = process.argv.slice(2);
const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));
const save = (label: string, x: unknown) => {
  mkdirSync('fixtures', { recursive: true });
  const f = `fixtures/${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(f, JSON.stringify(x, null, 2));
  console.log(`saved ${f}`);
};
const brief = (d: any) => ({ id: d.dispute_id, reason: d.reason, stage: d.dispute_life_cycle_stage, status: d.status, amount: d.dispute_amount, due: d.seller_response_due_date, actions: (d.links ?? []).map((l: any) => l.rel), offers: d.allowed_response_options, transactions: d.disputed_transactions });

const commands: Record<string, [string, () => Promise<unknown>]> = {
  token: ['check credentials', async () => { await pp.accessToken(); return 'Credentials work.'; }],
  order: ['<amount=25.00> create an order and print the buyer approval link (S1)', async () => {
    const o = await pp.createOrder({ reference_id: `spike-${Date.now()}`, amount: money(Number(a[0] ?? 25)), description: 'Dispute Desk spike', return_url: `${PUBLIC_BASE_URL}/paypal/return`, cancel_url: `${PUBLIC_BASE_URL}/`,
      ship_to: { name: 'Test Buyer', line1: '12 Elm Street', city: 'Austin', state: 'TX', postal_code: '78701', country_code: 'US' } });
    return { ...o, next: 'Open approve_url in a browser, log in as your sandbox PERSONAL (buyer) account and approve. Then: capture <id>' };
  }],
  capture: ['<orderId> capture an approved order; prints the capture (transaction) ID', async () => pp.captureOrder(a[0])],
  track: ['<captureId> <carrier> <trackingNumber> [SHIPPED|DELIVERED]', async () => { await pp.addTracking({ transaction_id: a[0], carrier: a[1], tracking_number: a[2], status: (a[3] as any) ?? 'SHIPPED' }); return 'tracking added'; }],
  disputes: ['[captureId] list disputes (optionally for one transaction)', async () => (await pp.listDisputes({ disputed_transaction_id: a[0] })).map(brief)],
  show: ['<disputeId> [label] show a dispute and save it as a fixture (S2)', async () => { const d = await pp.getDispute(a[0]); save(a[1] ?? `dispute-${d.status}`, d); return brief(d); }],
  watch: ['<disputeId> poll every 15s and print when status/actions change (how long until actions appear?)', async () => {
    let last = '';
    const t0 = Date.now();
    for (;;) {
      const d = await pp.getDispute(a[0]);
      const sig = `${d.dispute_life_cycle_stage}/${d.status}/${d.links.map((l) => l.rel).join(',')}`;
      if (sig !== last) { console.log(`+${Math.round((Date.now() - t0) / 1000)}s ${sig}`); last = sig; }
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }],
  evidence: ['<disputeId> <carrier> <trackingNumber> [notes] provide PROOF_OF_FULFILLMENT (S3)', async () => { await pp.provideEvidence(a[0], { evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [{ carrier_name: a[1], tracking_number: a[2] }] }, notes: a[3] ?? 'Shipped and delivered; tracking attached.' }] }); return brief(await pp.getDispute(a[0])); }],
  other: ['<disputeId> <notes> provide OTHER evidence (SNAD)', async () => { await pp.provideEvidence(a[0], { evidences: [{ evidence_type: 'OTHER', notes: a[1] }] }); return brief(await pp.getDispute(a[0])); }],
  offer: ['<disputeId> <amount> make a REFUND offer (S4)', async () => { await pp.makeOffer(a[0], { note: 'We would like to resolve this quickly.', offer_type: 'REFUND', offer_amount: money(Number(a[1])) }); return brief(await pp.getDispute(a[0])); }],
  accept: ['<disputeId> [partialAmount] accept the claim, fully or partially (S4)', async () => { await pp.acceptClaim(a[0], a[1] ? { note: 'Partial refund', accept_claim_type: 'PARTIAL_REFUND', refund_amount: money(Number(a[1])) } : { note: 'Accepting the claim', accept_claim_type: 'REFUND' }); return brief(await pp.getDispute(a[0])); }],
  escalate: ['<disputeId> escalate an inquiry to a claim', async () => { await pp.escalate(a[0], 'Escalating for review'); return brief(await pp.getDispute(a[0])); }],
  adjudicate: ['<disputeId> <SELLER_FAVOR|BUYER_FAVOR> sandbox only; needs UNDER_REVIEW', async () => { await pp.adjudicate(a[0], a[1] as any); return brief(await pp.getDispute(a[0])); }],
  'require-evidence': ['<disputeId> <SELLER_EVIDENCE|BUYER_EVIDENCE> sandbox only', async () => { await pp.requireEvidence(a[0], a[1] as any); return brief(await pp.getDispute(a[0])); }],
};

if (!cmd || !commands[cmd]) {
  console.log('Commands:\n' + Object.entries(commands).map(([k, [h]]) => `  ${k.padEnd(18)} ${h}`).join('\n'));
  process.exit(cmd ? 1 : 0);
}
try { show(await commands[cmd][1]()); }
catch (e) {
  if (e instanceof PayPalApiError) { console.error(`PayPal ${e.status} ${e.code} ${JSON.stringify(e.issues)}  debug_id=${e.debug_id}\n${e.message}`); process.exit(2); }
  throw e;
}
