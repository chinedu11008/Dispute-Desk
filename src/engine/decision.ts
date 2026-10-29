import type { Bucket, Reason } from '../domain/types.ts';
import type { PricedOption } from '../domain/analysis.ts';
import { money, round2 } from '../util/ids.ts';

export type Config = {
  /** Fee charged if a contested dispute is lost. Illustrative default; set it from your own PayPal fee schedule. */
  dispute_fee: number;
  offer_ratios: number[];
  min_fight_probability: number;
  /** Steepness of the buyer-acceptance curve q(x), a logistic in x/A. */
  offer_k: number;
  /** Refund ratio at which a buyer is 50% likely to accept. A buyer who got nothing (INR) wants nearly all of it back. */
  offer_mid_inr: number;
  offer_mid_snad: number;
  offer_mid_default: number;
  /** An offer must beat fighting by this share of the amount before it is preferred over fighting. */
  offer_margin: number;
  /** Offers the buyer is very unlikely to take are not credible, so they are not priced. */
  min_offer_acceptance: number;
};
export const DEFAULT_CONFIG: Config = {
  dispute_fee: 15, offer_ratios: [0.25, 0.5, 0.75, 0.9], min_fight_probability: 0.35, offer_k: 10,
  offer_mid_inr: 0.85, offer_mid_snad: 0.5, offer_mid_default: 0.6, offer_margin: 0.03, min_offer_acceptance: 0.15,
};

/** Pseudo-counts that encode our starting beliefs. They are assumptions, not PayPal data. */
const SEED: Record<Bucket, { wins: number; losses: number }> = {
  strong: { wins: 8, losses: 2 }, moderate: { wins: 5, losses: 5 }, weak: { wins: 2, losses: 8 },
};

export class Priors {
  observed: Record<string, { wins: number; losses: number }> = {};
  key(reason: Reason | string, bucket: Bucket) { return `${reason}|${bucket}`; }
  stats(reason: Reason | string, bucket: Bucket) {
    const s = SEED[bucket];
    const o = this.observed[this.key(reason, bucket)] ?? { wins: 0, losses: 0 };
    return { p: (s.wins + o.wins + 1) / (s.wins + s.losses + o.wins + o.losses + 2), n: o.wins + o.losses };
  }
  record(reason: Reason | string, bucket: Bucket, won: boolean) {
    const k = this.key(reason, bucket);
    const o = (this.observed[k] ??= { wins: 0, losses: 0 });
    if (won) o.wins++; else o.losses++;
  }
}

const fmt = (n: number, cur: string) => (cur === 'USD' ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${cur}`);
export const logistic = (x: number) => 1 / (1 + Math.exp(-x));
export const midFor = (reason: Reason | string | undefined, cfg: Config = DEFAULT_CONFIG) =>
  reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' ? cfg.offer_mid_inr : reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' ? cfg.offer_mid_snad : cfg.offer_mid_default;
export const qAccept = (ratio: number, cfg: Config = DEFAULT_CONFIG, reason?: Reason | string) => logistic(cfg.offer_k * (ratio - midFor(reason, cfg)));

export type Allowed = { can_fight: boolean; offer_types: string[]; accept_types: string[] };

/**
 * Expected loss, in currency, of each move. Lower is better.
 *   ACCEPT   = A
 *   FIGHT    = (1 - p) * (A + F)
 *   OFFER x  = q(x) * x + (1 - q(x)) * (1 - p) * (A + F)
 */
export function priceOptions(input: {
  amount: number; currency: string; reason: Reason; bucket: Bucket; allowed: Allowed; priors: Priors; config?: Partial<Config>;
}): PricedOption[] {
  const cfg = { ...DEFAULT_CONFIG, ...input.config };
  const { amount: A, currency, reason, bucket, allowed } = input;
  const F = cfg.dispute_fee;
  const { p, n } = input.priors.stats(reason, bucket);
  const assumed = n === 0;
  const fightLoss = (1 - p) * (A + F);
  const out: PricedOption[] = [];

  out.push({
    kind: 'ACCEPT', label: 'Accept the claim (full refund)', params: { accept_claim_type: 'REFUND' },
    expected_loss: round2(A), expected_recovered: 0, p_win: p, n_observed: n, assumed,
    rationale: `Refunding ${fmt(A, currency)} ends the dispute now with no further risk.`,
  });
  if (allowed.can_fight) {
    out.push({
      kind: 'FIGHT', label: 'Fight with evidence', params: {}, expected_loss: round2(fightLoss),
      expected_recovered: round2(A - fightLoss), p_win: p, n_observed: n, assumed,
      rationale: `${Math.round(p * 100)}% chance to win (${bucket} evidence); a loss costs the amount plus a ${fmt(F, currency)} fee.`,
    });
  }
  if (allowed.offer_types.includes('REFUND')) {
    let best: PricedOption | undefined;
    for (const r of cfg.offer_ratios) {
      const x = round2(A * r);
      const q = qAccept(r, cfg, reason);
      if (q < cfg.min_offer_acceptance) continue;
      const loss = q * x + (1 - q) * fightLoss;
      const cand: PricedOption = {
        kind: 'OFFER', label: `Offer a ${Math.round(r * 100)}% refund (${fmt(x, currency)})`,
        params: { offer_type: 'REFUND', offer_amount: money(x, currency) },
        expected_loss: round2(loss), expected_recovered: round2(A - loss), p_win: p, q_accept: round2(q),
        n_observed: n, assumed,
        rationale: `${Math.round(q * 100)}% chance the buyer accepts ${fmt(x, currency)}; otherwise the case continues at the fight odds.`,
      };
      if (!best || cand.expected_loss < best.expected_loss) best = cand;
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => a.expected_loss - b.expected_loss);
}

export function recommend(options: PricedOption[], amount: number, config: Partial<Config> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sorted = [...options].sort((a, b) => a.expected_loss - b.expected_loss);
  const fight = options.find((o) => o.kind === 'FIGHT');
  const notes: string[] = [];
  let pick = sorted[0];
  if (pick.kind === 'OFFER' && fight && fight.expected_loss - pick.expected_loss < cfg.offer_margin * amount) {
    pick = fight;
    notes.push('The best offer beats fighting by less than the margin, so fighting is preferred.');
  }
  if (pick.kind === 'FIGHT' && pick.p_win < cfg.min_fight_probability) {
    const alt = sorted.find((o) => o.kind !== 'FIGHT');
    if (alt) { pick = alt; notes.push(`Win probability is below ${Math.round(cfg.min_fight_probability * 100)}%, so fighting is not recommended.`); }
  }
  if (pick.assumed) notes.push('Probabilities use starting assumptions; no resolved cases yet.');
  return { recommended: pick, notes };
}
