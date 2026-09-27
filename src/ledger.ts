// The ledger (data/ledger.json) is the rich record of every claim: quote,
// deep link, deadline, grading, drift and GBrain sync state. This module
// owns reading, writing and merging it; everything else goes through here.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Claim, Ledger } from './types.ts';

/** "Elon Musk" -> "elon-musk". Apostrophes vanish ("O'Brien" -> "obrien"), like GBrain's entity slugs. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Lowercase, straight quotes, no punctuation, single spaces: two wordings
// that differ only in case or punctuation get the same id.
function normalizeClaimText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable 12-hex id: sha1 of slug, date and normalized claim text. */
export function claimId(personSlug: string, saidDate: string, claim: string): string {
  const key = `${personSlug}|${saidDate}|${normalizeClaimText(claim)}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

export function emptyLedger(): Ledger {
  return { version: 1, updatedAt: new Date().toISOString(), claims: [] };
}

export function loadLedger(path: string): Ledger {
  if (!existsSync(path)) return emptyLedger();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Ledger ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const l = parsed as Partial<Ledger> | null;
  if (!l || l.version !== 1 || !Array.isArray(l.claims)) {
    throw new Error(`Ledger ${path} is not a version 1 ledger ({ "version": 1, "claims": [...] })`);
  }
  return { version: 1, updatedAt: l.updatedAt ?? new Date().toISOString(), claims: l.claims };
}

function compareClaims(a: Claim, b: Claim): number {
  return (
    a.personSlug.localeCompare(b.personSlug) ||
    a.saidDate.localeCompare(b.saidDate) ||
    a.id.localeCompare(b.id)
  );
}

/** Pretty JSON, claims sorted by person then saidDate, written atomically (tmp + rename). */
export function saveLedger(path: string, l: Ledger): void {
  const out: Ledger = { version: 1, updatedAt: new Date().toISOString(), claims: [...l.claims].sort(compareClaims) };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  renameSync(tmp, path);
}

/**
 * Reload the ledger file, apply `change`, save, and return what was saved.
 * Long runs (an ingest, a grading pass, a GBrain sync) save through this, so
 * their changes merge into whatever another process wrote meanwhile instead
 * of writing back the snapshot they started from.
 */
export function updateLedger(path: string, change: (l: Ledger) => Ledger | void): Ledger {
  const fresh = loadLedger(path);
  const next = change(fresh) ?? fresh;
  saveLedger(path, next);
  return next;
}

/** Copy the defined values of `fields` from each claim onto the ledger claim with the same id (mutates `l`). */
export function patchClaims(l: Ledger, from: readonly Claim[], fields: readonly (keyof Claim)[]): void {
  const at = new Map(l.claims.map((c, i) => [c.id, i]));
  for (const c of from) {
    const i = at.get(c.id);
    if (i === undefined) continue;
    const patch = Object.fromEntries(fields.filter((f) => c[f] !== undefined).map((f) => [f, c[f]]));
    l.claims[i] = { ...l.claims[i]!, ...patch };
  }
}

function withId(c: Claim): Claim {
  return c.id ? c : { ...c, id: claimId(c.personSlug, c.saidDate, c.claim) };
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// Re-extracting an episode yields a fresh 'pending' claim with no grading,
// drift or GBrain state; merging must keep what the ledger already learned.
function mergeClaim(existing: Claim, incoming: Claim): Claim {
  const merged: Claim = { ...existing, ...definedOnly(incoming) };
  if (!incoming.grading) merged.verdict = existing.verdict;
  if (existing.gbrain && incoming.gbrain) merged.gbrain = { ...existing.gbrain, ...definedOnly(incoming.gbrain) };
  merged.quoteVerified = existing.quoteVerified || incoming.quoteVerified;
  if (existing.origin === 'seed') merged.origin = 'seed';
  return merged;
}

/**
 * Merge claims into the ledger by id (mutates `l`). Claims without an id get
 * claimId(). `updated` only lists claims whose content actually changed.
 */
export function upsertClaims(l: Ledger, claims: Claim[]): { added: Claim[]; updated: Claim[] } {
  const index = new Map(l.claims.map((c, i) => [c.id, i]));
  const added = new Map<string, Claim>();
  const updated = new Map<string, Claim>();
  for (const raw of claims) {
    const incoming = withId(raw);
    const at = index.get(incoming.id);
    if (at === undefined) {
      index.set(incoming.id, l.claims.length);
      l.claims.push(incoming);
      added.set(incoming.id, incoming);
      continue;
    }
    const existing = l.claims[at]!;
    const merged = mergeClaim(existing, incoming);
    if (JSON.stringify(merged) === JSON.stringify(existing)) continue;
    l.claims[at] = merged;
    if (added.has(merged.id)) added.set(merged.id, merged);
    else updated.set(merged.id, merged);
  }
  return { added: [...added.values()], updated: [...updated.values()] };
}

/** One person's claims, oldest first. */
export function claimsFor(l: Ledger, personSlug: string): Claim[] {
  return l.claims.filter((c) => c.personSlug === personSlug).sort(compareClaims);
}

/** Predictions whose deadline has passed and that still need a verdict, earliest deadline first. */
export function dueClaims(
  l: Ledger,
  today: string,
  opts: { personSlug?: string; includeGraded?: boolean } = {},
): Claim[] {
  return l.claims
    .filter(
      (c) =>
        c.type === 'prediction' &&
        c.targetDate !== undefined &&
        c.targetDate <= today &&
        (opts.includeGraded || c.verdict === 'pending' || c.verdict === 'too_early') &&
        (opts.personSlug === undefined || c.personSlug === opts.personSlug),
    )
    .sort((a, b) => a.targetDate!.localeCompare(b.targetDate!) || compareClaims(a, b));
}
