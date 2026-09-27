// The people you follow (watchlist.json) and what discovery found for them
// (discoveries.json). Both files sit next to the ledger, so a temp ledger in
// tests isolates everything. Writes are atomic (tmp + rename), like the ledger.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { sourceKey } from './discover.ts';
import { slugify } from './ledger.ts';
import type { Candidate, CandidateStatus, DiscoveredCandidate, DiscoveryRecord, DiscoveryStore, Watchlist, WatchPerson } from './types.ts';

const MAX_NAME = 120;
const STATUSES: readonly CandidateStatus[] = ['new', 'pulling', 'pulled', 'failed', 'have'];

export function watchlistPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), 'watchlist.json');
}

export function discoveriesPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), 'discoveries.json');
}

function writeAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** "  jensen   huang " -> "Jensen Huang". Only the first letter of each token changes, so "McKinsey" and "de" keep theirs. */
export function titleCaseName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((t) => (t ? t[0]!.toUpperCase() + t.slice(1) : t))
    .join(' ');
}

// ---- Watchlist ------------------------------------------------------------------

export function loadWatchlist(path: string): Watchlist {
  if (!existsSync(path)) return { version: 1, people: [] };
  const data = readJson(path);
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.people)) {
    throw new Error(`${path} is not a Receipts watchlist (expected {"version": 1, "people": [...]}).`);
  }
  const people = data.people.filter(
    (p): p is WatchPerson => isRecord(p) && typeof p.name === 'string' && typeof p.slug === 'string' && typeof p.followedAt === 'string',
  );
  return { version: 1, people };
}

export function saveWatchlist(path: string, w: Watchlist): void {
  writeAtomic(path, w);
}

/** Adds (or returns the existing entry, matched by slug). Name is trimmed, whitespace-collapsed, title-cased per token; throws on an empty slug or a name over 120 chars. */
export function follow(path: string, name: string, now: Date = new Date()): { person: WatchPerson; created: boolean } {
  const display = titleCaseName(name);
  if (display.length > MAX_NAME) throw new Error(`A name can be at most ${MAX_NAME} characters.`);
  const slug = slugify(display);
  if (!slug) throw new Error('The name needs at least one letter or digit.');
  const w = loadWatchlist(path);
  const existing = w.people.find((p) => p.slug === slug);
  if (existing) return { person: existing, created: false };
  const person: WatchPerson = { name: display, slug, followedAt: now.toISOString() };
  w.people.push(person);
  saveWatchlist(path, w);
  return { person, created: true };
}

/** Accepts a slug or a name. Returns false when not followed. Keeps the person's discoveries. */
export function unfollow(path: string, nameOrSlug: string): boolean {
  const slug = slugify(nameOrSlug);
  const w = loadWatchlist(path);
  const kept = w.people.filter((p) => p.slug !== slug);
  if (kept.length === w.people.length) return false;
  saveWatchlist(path, { version: 1, people: kept });
  return true;
}

export function findFollowed(path: string, nameOrSlug: string): WatchPerson | undefined {
  const slug = slugify(nameOrSlug);
  return loadWatchlist(path).people.find((p) => p.slug === slug);
}

export function markChecked(path: string, slug: string, now: Date = new Date()): void {
  const w = loadWatchlist(path);
  const p = w.people.find((x) => x.slug === slug);
  if (!p) return;
  p.lastCheckedAt = now.toISOString();
  saveWatchlist(path, w);
}

// ---- Discoveries ---------------------------------------------------------------------

export function loadDiscoveries(path: string): DiscoveryStore {
  if (!existsSync(path)) return { version: 1, bySlug: {} };
  const data = readJson(path);
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.bySlug)) {
    throw new Error(`${path} is not a Receipts discoveries file (expected {"version": 1, "bySlug": {...}}).`);
  }
  return data as unknown as DiscoveryStore;
}

function keyOf(url: string): string {
  return sourceKey(url) ?? url;
}

/** Merge a discovery run: existing candidates (by sourceKey) keep their status, pulledAt, receipts; new ones get status 'new' (or 'have' when already in the ledger). */
export function recordDiscovery(
  path: string,
  slug: string,
  run: { since: string; candidates: Candidate[]; have: Set<string> },
  now: Date = new Date(),
): DiscoveryRecord {
  const store = loadDiscoveries(path);
  const prev = store.bySlug[slug];
  const byKey = new Map((prev?.candidates ?? []).map((c) => [keyOf(c.url), c]));
  const seen = new Set<string>();
  const candidates: DiscoveredCandidate[] = [];
  for (const c of run.candidates) {
    const key = keyOf(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    const old = byKey.get(key);
    const inLedger = run.have.has(key);
    if (old) {
      const keep: DiscoveredCandidate = { ...c, status: old.status, foundAt: old.foundAt };
      if (old.pulledAt) keep.pulledAt = old.pulledAt;
      if (old.receipts !== undefined) keep.receipts = old.receipts;
      if (old.error) keep.error = old.error;
      if (inLedger && (keep.status === 'new' || keep.status === 'failed')) keep.status = 'have';
      // A pull that died with the process never finished.
      if (keep.status === 'pulling') keep.status = inLedger ? 'have' : 'new';
      candidates.push(keep);
    } else {
      candidates.push({ ...c, status: inLedger ? 'have' : 'new', foundAt: now.toISOString() });
    }
  }
  // Earlier finds this run did not return stay listed (after the fresh ones), so a pulled row never vanishes.
  for (const old of prev?.candidates ?? []) if (!seen.has(keyOf(old.url))) candidates.push(old);
  const record: DiscoveryRecord = { checkedAt: now.toISOString(), since: run.since, candidates };
  store.bySlug[slug] = record;
  writeAtomic(path, store);
  return record;
}

export function setCandidateStatus(
  path: string,
  slug: string,
  url: string,
  patch: Partial<Pick<DiscoveredCandidate, 'status' | 'pulledAt' | 'receipts' | 'error'>>,
): void {
  if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`Unknown candidate status "${patch.status}".`);
  const store = loadDiscoveries(path);
  const record = store.bySlug[slug];
  const key = keyOf(url);
  const c = record?.candidates.find((x) => keyOf(x.url) === key);
  if (!c) return;
  Object.assign(c, patch);
  if (patch.status && patch.status !== 'failed' && patch.error === undefined) delete c.error;
  writeAtomic(path, store);
}

export function findCandidate(path: string, slug: string, url: string): DiscoveredCandidate | undefined {
  const key = keyOf(url);
  return loadDiscoveries(path).bySlug[slug]?.candidates.find((c) => keyOf(c.url) === key);
}
