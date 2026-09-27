// Merges data/seed/parts/*.json into data/seed/predictions.json: ids come
// from claimId() (the parts ship "id": ""), claims are sorted like the
// ledger (person, date, id), and the result is validated before it is
// written. The parts stay as the editable source.
//
//   bun scripts/build-seed.ts [--today YYYY-MM-DD]

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { utcToday } from '../src/config.ts';
import { claimId } from '../src/ledger.ts';
import type { Claim } from '../src/types.ts';
import { DEFAULT_SEED_PATH, formatReport, validateSeed } from './validate-seed.ts';

export const PARTS_DIR = join(import.meta.dir, '..', 'data', 'seed', 'parts');

export interface SeedFile {
  version: 1;
  claims: Claim[];
}

function readPart(path: string): Claim[] {
  const data = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; claims?: unknown } | unknown[];
  const claims = Array.isArray(data) ? data : data.claims;
  if (!Array.isArray(claims)) throw new Error(`${path}: expected { "version": 1, "claims": [...] } or a list of claims`);
  return claims as Claim[];
}

function byPersonDateId(a: Claim, b: Claim): number {
  return a.personSlug.localeCompare(b.personSlug) || a.saidDate.localeCompare(b.saidDate) || a.id.localeCompare(b.id);
}

/** The merged seed plus notes about ids that were replaced. Throws on duplicate claims across parts. */
export function buildSeed(partsDir: string = PARTS_DIR): { seed: SeedFile; notes: string[] } {
  const notes: string[] = [];
  const byId = new Map<string, string>();
  const claims: Claim[] = [];
  for (const file of readdirSync(partsDir).filter((f) => f.endsWith('.json')).sort()) {
    for (const raw of readPart(join(partsDir, file))) {
      const id = claimId(raw.personSlug, raw.saidDate, raw.claim);
      if (raw.id && raw.id !== id) notes.push(`${file}: ${raw.personSlug} ${raw.saidDate}: id ${raw.id} replaced by ${id}`);
      const seenIn = byId.get(id);
      if (seenIn) throw new Error(`${file}: ${raw.personSlug} ${raw.saidDate} "${raw.claim}" duplicates a claim in ${seenIn}`);
      byId.set(id, file);
      claims.push({ ...raw, id });
    }
  }
  return { seed: { version: 1, claims: claims.sort(byPersonDateId) }, notes };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const todayAt = args.indexOf('--today');
  const today = todayAt >= 0 ? args[todayAt + 1]! : process.env.RECEIPTS_TODAY || utcToday();
  const { seed, notes } = buildSeed();
  for (const n of notes) console.log(`note: ${n}`);
  const report = validateSeed(seed, today);
  console.log(formatReport(report, DEFAULT_SEED_PATH));
  if (report.errors.length) {
    console.error('Not written: fix the errors in data/seed/parts first.');
    process.exitCode = 1;
  } else {
    writeFileSync(DEFAULT_SEED_PATH, `${JSON.stringify(seed, null, 2)}\n`);
    console.log(`Wrote ${seed.claims.length} claims to ${DEFAULT_SEED_PATH}`);
  }
}
