import { AuditLog } from './audit/audit.ts';
import { CachingLLM, ClaudeLLM, HeuristicLLM } from './agent/llm.ts';
import type { LLM } from './agent/llm.ts';
import { DEFAULT_CONFIG, Priors } from './engine/decision.ts';
import type { Config } from './engine/decision.ts';
import { CaseManager } from './orchestrator/cases.ts';
import { LivePayPal } from './paypal/live.ts';
import type { PayPalGateway } from './paypal/gateway.ts';
import { SimulatedPayPal } from './paypal/simulator.ts';
import { OrderBook } from './store/orders.ts';
import { systemClock } from './util/ids.ts';
import type { Clock } from './util/ids.ts';
import { Vault } from './vault/vault.ts';

export type AppContext = {
  mode: 'SIMULATED' | 'LIVE_SANDBOX';
  clock: Clock; vault: Vault; audit: AuditLog; gateway: PayPalGateway; sim?: SimulatedPayPal;
  orders: OrderBook; cases: CaseManager; llm: LLM; priors: Priors; config: Partial<Config>;
};

export function buildContext(env: Record<string, string | undefined> = {}, opts: { clock?: Clock; llm?: LLM; config?: Partial<Config> } = {}): AppContext {
  const clock = opts.clock ?? systemClock;
  const mode = env.MODE === 'LIVE_SANDBOX' ? 'LIVE_SANDBOX' : 'SIMULATED';
  const vault = new Vault(clock);
  const audit = new AuditLog(clock);
  const priors = new Priors();
  const config = { ...DEFAULT_CONFIG, ...opts.config };
  const baseUrl = env.PUBLIC_BASE_URL ?? 'http://localhost:3000';

  let llm: LLM = opts.llm ?? new HeuristicLLM();
  if (!opts.llm && env.LLM === 'claude' && env.ANTHROPIC_API_KEY) {
    llm = new ClaudeLLM({ apiKey: env.ANTHROPIC_API_KEY, fastModel: env.CLAUDE_FAST_MODEL, smartModel: env.CLAUDE_SMART_MODEL });
  }
  if (!opts.llm && (env.LLM_CACHE === 'record' || env.LLM_CACHE === 'replay')) llm = new CachingLLM(llm, 'cache/llm.json', env.LLM_CACHE);

  const ctx = { mode, clock, vault, audit, priors, config, llm } as AppContext;
  if (mode === 'SIMULATED') {
    ctx.sim = new SimulatedPayPal({
      clock, sink: (e) => ctx.cases.handleWebhook({ headers: { 'x-sim-signature': 'valid' }, rawBody: JSON.stringify(e) }),
    });
    ctx.gateway = ctx.sim;
  } else {
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('LIVE_SANDBOX needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
    ctx.gateway = new LivePayPal({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, webhookId: env.PAYPAL_WEBHOOK_ID, baseUrl: env.PAYPAL_BASE_URL });
  }
  ctx.orders = new OrderBook(ctx.gateway, vault, clock, baseUrl);
  ctx.cases = new CaseManager({ gateway: ctx.gateway, vault, audit, llm, priors, config, policy: {}, clock, orders: ctx.orders });
  return ctx;
}
