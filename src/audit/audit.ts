import { iso, sha256, systemClock } from '../util/ids.ts';
import type { Clock } from '../util/ids.ts';

export type AuditEntry = {
  seq: number; ts: string; actor: 'agent' | 'user' | 'system' | 'paypal'; event: string;
  case_id?: string; data: any; prev_hash: string; hash: string;
};
const GENESIS = '0'.repeat(64);

/** Append-only, hash-chained log. Editing or removing any entry breaks verify(). */
export class AuditLog {
  entries: AuditEntry[] = [];
  clock: Clock;
  constructor(clock: Clock = systemClock) { this.clock = clock; }

  static hashOf(e: Omit<AuditEntry, 'hash'>): string {
    return sha256([e.prev_hash, e.seq, e.ts, e.actor, e.event, e.case_id ?? '', JSON.stringify(e.data ?? null)].join('|'));
  }
  append(actor: AuditEntry['actor'], event: string, data: any = {}, case_id?: string): AuditEntry {
    const prev_hash = this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS;
    const base = { seq: this.entries.length + 1, ts: iso(this.clock()), actor, event, case_id, data, prev_hash };
    const entry: AuditEntry = { ...base, hash: AuditLog.hashOf(base) };
    this.entries.push(entry);
    return entry;
  }
  verify(): { ok: boolean; broken_at?: number } {
    let prev = GENESIS;
    for (const e of this.entries) {
      const { hash, ...rest } = e;
      if (e.prev_hash !== prev || AuditLog.hashOf(rest) !== hash) return { ok: false, broken_at: e.seq };
      prev = hash;
    }
    return { ok: true };
  }
  forCase(case_id: string): AuditEntry[] { return this.entries.filter((e) => e.case_id === case_id); }
}
