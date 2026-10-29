const CITE = /\[(EV-\d{4})\]/g;
const EXEMPT_PREFIXES = [
  'hello', 'hi ', 'hi,', 'dear', 'thank', 'please', 'sincerely', 'regards', 'best', 'if you', 'i would', 'i will',
  'we would', 'we will', 'we are offering', 'we are happy', 'we are sorry', "we're sorry", 'we accept', 'we apologi',
  'we propose', 'we offer',
];

export type Violation = { sentence: string; reason: 'UNCITED' | 'UNKNOWN_CITATION'; id?: string };

export const splitSentences = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
export const citationsIn = (text: string): string[] => [...text.matchAll(CITE)].map((m) => m[1]);
const wordCount = (s: string) => s.replace(CITE, '').split(/\s+/).filter(Boolean).length;

/** Every factual sentence must cite at least one stored evidence item, and every citation must exist. */
export function checkCitations(text: string, allowed: Set<string>) {
  const violations: Violation[] = [];
  for (const s of splitSentences(text)) {
    const ids = citationsIn(s);
    const lower = s.replace(/^[\s"'(]+/, '').toLowerCase();
    const exempt = s.endsWith('?') || wordCount(s) < 6 || EXEMPT_PREFIXES.some((p) => lower.startsWith(p));
    if (ids.length === 0 && !exempt) violations.push({ sentence: s, reason: 'UNCITED' });
    for (const id of ids) if (!allowed.has(id)) violations.push({ sentence: s, reason: 'UNKNOWN_CITATION', id });
  }
  return { ok: violations.length === 0, cited: [...new Set(citationsIn(text))], violations };
}

/** PayPal reviewers cannot resolve our IDs, so outgoing text refers to numbered exhibits instead. */
export const toExhibits = (text: string): string => text.replace(CITE, '(Exhibit $1)');
