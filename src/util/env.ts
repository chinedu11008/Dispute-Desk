import { existsSync, readFileSync } from 'node:fs';

/** Minimal .env loader so the project needs no dependencies. Existing environment variables win. */
export function loadEnv(path = '.env', target: Record<string, string | undefined> = process.env) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (target[m[1]] === undefined || target[m[1]] === '') target[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
