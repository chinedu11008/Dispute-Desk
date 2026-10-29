import { createHash, randomBytes } from 'node:crypto';
import type { Money } from '../domain/types.ts';

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
export const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');
export const rid = (prefix: string): string => `${prefix}_${randomBytes(4).toString('hex')}`;
export const iso = (d: Date): string => d.toISOString();
export const money = (n: number, currency = 'USD'): Money => ({ currency_code: currency, value: n.toFixed(2) });
export const amt = (m: Money): number => Number(m.value);
export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000);

/** A clock you can move forward in tests and demos. */
export function manualClock(start = '2026-10-12T09:00:00.000Z'): Clock & { advance(ms: number): void } {
  let t = new Date(start).getTime();
  const c = (() => new Date(t)) as Clock & { advance(ms: number): void };
  c.advance = (ms: number) => { t += ms; };
  return c;
}
