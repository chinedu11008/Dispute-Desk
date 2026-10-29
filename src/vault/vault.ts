import type { EvidenceItem, EvidenceKind } from '../domain/types.ts';
import { iso, sha256, systemClock } from '../util/ids.ts';
import type { Clock } from '../util/ids.ts';

export type NewEvidence = {
  transaction_id: string;
  kind: EvidenceKind;
  source: string;
  summary: string;
  payload?: Record<string, any>;
  captured_at?: string;
};

/** Append-only evidence store keyed by PayPal transaction (capture) ID. Updates are new items; history stays. */
export class Vault {
  items: EvidenceItem[] = [];
  seq = 0;
  clock: Clock;
  constructor(clock: Clock = systemClock) { this.clock = clock; }

  add(input: NewEvidence): EvidenceItem {
    const id = `EV-${String(++this.seq).padStart(4, '0')}`;
    const captured_at = input.captured_at ?? iso(this.clock());
    const payload = input.payload ?? {};
    const hash = sha256(JSON.stringify([id, input.transaction_id, input.kind, input.source, captured_at, input.summary, payload]));
    const item: EvidenceItem = Object.freeze({
      id, transaction_id: input.transaction_id, kind: input.kind, source: input.source,
      captured_at, summary: input.summary, payload, sha256: hash,
    });
    this.items.push(item);
    return item;
  }
  forTransaction(tx: string): EvidenceItem[] { return this.items.filter((i) => i.transaction_id === tx); }
  ids(tx: string): Set<string> { return new Set(this.forTransaction(tx).map((i) => i.id)); }
  get(id: string): EvidenceItem | undefined { return this.items.find((i) => i.id === id); }
  latest(tx: string, kind: EvidenceKind): EvidenceItem | undefined {
    const xs = this.forTransaction(tx).filter((i) => i.kind === kind);
    return xs[xs.length - 1];
  }
}
