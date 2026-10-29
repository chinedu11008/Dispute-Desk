import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { AppContext } from '../app.ts';
import type { Case } from '../orchestrator/cases.ts';
import { CATALOG } from '../store/orders.ts';
import { SCENARIOS, seedScenario } from '../store/scenarios.ts';
import type { ScenarioName } from '../store/scenarios.ts';

const PUBLIC = join(import.meta.dirname, '..', '..', 'public');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body));
};
const readBody = (req: IncomingMessage) => new Promise<string>((ok, bad) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => ok(Buffer.concat(chunks).toString('utf8'))).on('error', bad);
});
const parse = (raw: string) => { try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('Body is not valid JSON'), { status: 400 }); } };

export function summarize(ctx: AppContext, c: Case) {
  const a = c.analysis;
  return {
    id: c.id, dispute_id: c.dispute_id, state: c.state, reason: c.dispute.reason, stage: c.dispute.dispute_life_cycle_stage, status: c.dispute.status,
    amount: c.dispute.dispute_amount, due: c.dispute.seller_response_due_date, created_at: c.created_at,
    order_title: c.order_id ? ctx.orders.orders.get(c.order_id)?.title : undefined,
    strength: a?.assessment.strength, bucket: a?.assessment.bucket, recommendation: a?.recommendation.kind, recommendation_label: a?.recommendation.label, offer_amount: a?.recommendation.params.offer_amount,
    flags: a?.risk_flags ?? [], outcome: c.outcome,
  };
}
export function detail(ctx: AppContext, c: Case) {
  return {
    ...summarize(ctx, c), dispute: c.dispute, analysis: c.analysis, approvals: c.approvals, rejected: c.rejected, executed: c.executed,
    order: c.order_id ? ctx.orders.orders.get(c.order_id) : undefined,
    evidence: ctx.vault.forTransaction(c.transaction_id), audit: ctx.audit.forCase(c.id),
    policy: Object.fromEntries((c.analysis?.proposals ?? []).map((p) => [p.id, ctx.cases.check(c.id, p.id)])),
  };
}

async function route(ctx: AppContext, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const m = req.method ?? 'GET';
  const seg = path.split('/').filter(Boolean);

  if (path === '/healthz') return send(res, 200, { ok: true, mode: ctx.mode, llm: ctx.llm.name });

  if (m === 'POST' && path === '/webhooks/paypal') {
    const out = await ctx.cases.handleWebhook({ headers: req.headers, rawBody: await readBody(req) });
    return send(res, out.status === 'rejected' ? 400 : 200, out);
  }

  if (m === 'GET' && path === '/api/cases') return send(res, 200, ctx.cases.list().map((c) => summarize(ctx, c)));
  if (m === 'GET' && seg[0] === 'api' && seg[1] === 'cases' && seg.length === 3) return send(res, 200, detail(ctx, ctx.cases.get(seg[2])));
  if (m === 'POST' && seg[0] === 'api' && seg[1] === 'cases' && seg.length === 4) {
    const body = parse(await readBody(req));
    const approver = String(body.approver ?? 'merchant');
    if (seg[3] === 'check') return send(res, 200, ctx.cases.check(seg[2], String(body.proposal_id), body.edits));
    const c = seg[3] === 'approve' ? await ctx.cases.approve(seg[2], String(body.proposal_id), approver, body.edits)
      : seg[3] === 'reject' ? await ctx.cases.reject(seg[2], String(body.proposal_id), approver, String(body.reason ?? ''))
      : undefined;
    if (!c) return send(res, 404, { error: 'Unknown action' });
    return send(res, 200, detail(ctx, c));
  }
  if (m === 'GET' && path === '/api/kpis') return send(res, 200, { ...ctx.cases.kpis(), audit: ctx.audit.verify(), mode: ctx.mode, llm: ctx.llm.name });

  // ---- demo store ----
  if (m === 'GET' && path === '/api/catalog') return send(res, 200, CATALOG);
  if (m === 'GET' && path === '/api/orders') return send(res, 200, [...ctx.orders.orders.values()]);
  if (m === 'POST' && path === '/api/checkout') {
    const body = parse(await readBody(req));
    const { order, approve_url } = await ctx.orders.checkout(String(body.sku), body.ship_to ?? { name: 'Alex Rivera', line1: '12 Elm Street', city: 'Austin', state: 'TX', postal_code: '78701', country_code: 'US' });
    return send(res, 200, { order, approve_url });
  }
  if (m === 'GET' && path === '/sim/approve' && ctx.sim) {
    const token = url.searchParams.get('token') ?? '';
    ctx.sim.approveOrder(token);
    res.writeHead(302, { location: `/paypal/return?token=${encodeURIComponent(token)}` });
    return res.end();
  }
  if (m === 'GET' && path === '/paypal/return') {
    const order = await ctx.orders.capture(url.searchParams.get('token') ?? '');
    return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Thanks</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto"><h1>Payment received</h1><p>${order.title} (${order.amount.value} ${order.amount.currency_code}) is paid. Capture ID <code>${order.capture_id}</code>.</p><p><a href="/">Back to the console</a></p>`, 'text/html; charset=utf-8');
  }
  if (m === 'POST' && seg[0] === 'api' && seg[1] === 'orders' && seg.length === 4) {
    const body = parse(await readBody(req));
    if (seg[3] === 'ship') await ctx.orders.ship(seg[2], String(body.carrier ?? 'UPS'), String(body.tracking_number ?? `1Z${Date.now()}`));
    else if (seg[3] === 'deliver') await ctx.orders.deliver(seg[2], { verified: !!body.verified, proof: body.proof });
    else return send(res, 404, { error: 'Unknown action' });
    return send(res, 200, ctx.orders.get(seg[2]));
  }

  // ---- simulator controls (SIMULATED mode only) ----
  if (seg[0] === 'api' && seg[1] === 'demo') {
    if (!ctx.sim) return send(res, 404, { error: 'Demo controls exist only in SIMULATED mode' });
    const body = m === 'POST' ? parse(await readBody(req)) : {};
    if (m === 'GET' && seg[2] === 'scenarios') return send(res, 200, SCENARIOS);
    if (m === 'POST' && seg[2] === 'scenario') {
      if (!SCENARIOS.includes(body.name)) return send(res, 400, { error: `name must be one of ${SCENARIOS.join(', ')}` });
      const { dispute } = await seedScenario(body.name as ScenarioName, { sim: ctx.sim, orders: ctx.orders, clock: ctx.clock });
      await ctx.sim.settle();
      const c = ctx.cases.list().find((x) => x.dispute_id === dispute.dispute_id);
      return send(res, 200, c ? detail(ctx, c) : { dispute_id: dispute.dispute_id });
    }
    if (m === 'POST' && seg[2] === 'adjudicate') { await ctx.sim.adjudicate(String(body.dispute_id), body.outcome === 'BUYER_FAVOR' ? 'BUYER_FAVOR' : 'SELLER_FAVOR'); await ctx.sim.settle(); return send(res, 200, { ok: true }); }
    if (m === 'POST' && seg[2] === 'buyer') {
      const id = String(body.dispute_id);
      if (body.action === 'accept-offer') ctx.sim.buyerAcceptsOffer(id); else if (body.action === 'deny-offer') ctx.sim.buyerDeniesOffer(id); else return send(res, 400, { error: 'action must be accept-offer or deny-offer' });
      await ctx.sim.settle();
      return send(res, 200, { ok: true });
    }
  }

  // ---- static console ----
  if (m === 'GET') {
    const file = normalize(join(PUBLIC, path === '/' ? 'index.html' : path));
    if (file.startsWith(PUBLIC)) {
      try { return send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream'); } catch { /* fall through */ }
    }
  }
  return send(res, 404, { error: 'Not found' });
}

export function createApp(ctx: AppContext): Server {
  return createServer((req, res) => {
    route(ctx, req, res).catch((e: Error & { status?: number }) => {
      const status = e.status ?? (/Unknown|not found/i.test(e.message) ? 404 : /nothing to approve|Illegal|awaiting/i.test(e.message) ? 409 : 400);
      if (!res.headersSent) send(res, status, { error: e.message }); else res.end();
    });
  });
}
