// Watchlist and discoveries stores: follow/unfollow, atomic writes, merging
// discovery runs without losing pull status.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Candidate } from '../src/types.ts';
import {
  discoveriesPath,
  findCandidate,
  follow,
  loadDiscoveries,
  loadWatchlist,
  markChecked,
  recordDiscovery,
  setCandidateStatus,
  titleCaseName,
  unfollow,
  watchlistPath,
} from '../src/watchlist.ts';

const dir = mkdtempSync(join(tmpdir(), 'receipts-watchlist-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fresh(name: string): { dir: string; wl: string; ds: string } {
  const d = mkdtempSync(join(dir, `${name}-`));
  const ledger = join(d, 'ledger.json');
  return { dir: d, wl: watchlistPath(ledger), ds: discoveriesPath(ledger) };
}

function cand(url: string, over: Partial<Candidate> = {}): Candidate {
  return { title: url, show: 'S', date: '2026-09-01', url, kind: 'podcast', transcriptSource: 'youtube', why: 'w', linkConfirmed: true, ...over };
}

describe('paths', () => {
  test('next to the ledger', () => {
    expect(watchlistPath('/x/data/ledger.json')).toBe('/x/data/watchlist.json');
    expect(discoveriesPath('/x/data/ledger.json')).toBe('/x/data/discoveries.json');
  });
});

describe('follow / unfollow', () => {
  test('missing file is empty; follow twice is one entry; title-cased', () => {
    const { wl } = fresh('f');
    expect(loadWatchlist(wl)).toEqual({ version: 1, people: [] });
    const a = follow(wl, '  jensen   huang ', new Date('2026-09-27T12:00:00Z'));
    expect(a.created).toBe(true);
    expect(a.person).toEqual({ name: 'Jensen Huang', slug: 'jensen-huang', followedAt: '2026-09-27T12:00:00.000Z' });
    const b = follow(wl, 'Jensen Huang');
    expect(b.created).toBe(false);
    expect(b.person.followedAt).toBe('2026-09-27T12:00:00.000Z');
    expect(loadWatchlist(wl).people).toHaveLength(1);
  });

  test('title case keeps inner capitals', () => {
    expect(titleCaseName('lisa su')).toBe('Lisa Su');
    expect(titleCaseName('ursula von der leyen')).toBe('Ursula Von Der Leyen');
    expect(titleCaseName('sam McAllister')).toBe('Sam McAllister');
  });

  test('empty slug and long names throw', () => {
    const { wl } = fresh('bad');
    expect(() => follow(wl, '!!!')).toThrow(/letter or digit/);
    expect(() => follow(wl, 'a'.repeat(121))).toThrow(/120/);
  });

  test('unfollow by name and by slug; unknown is false; atomic write leaves no tmp file', () => {
    const { wl, dir: d } = fresh('u');
    follow(wl, 'Lisa Su');
    follow(wl, 'Sam Altman');
    expect(unfollow(wl, 'lisa su')).toBe(true);
    expect(unfollow(wl, 'sam-altman')).toBe(true);
    expect(unfollow(wl, 'Nobody Here')).toBe(false);
    expect(loadWatchlist(wl).people).toEqual([]);
    expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('markChecked stamps lastCheckedAt', () => {
    const { wl } = fresh('m');
    follow(wl, 'Lisa Su');
    markChecked(wl, 'lisa-su', new Date('2026-09-27T01:02:03Z'));
    expect(loadWatchlist(wl).people[0]!.lastCheckedAt).toBe('2026-09-27T01:02:03.000Z');
    markChecked(wl, 'not-followed');
  });

  test('invalid files throw with the path', () => {
    const { wl, ds } = fresh('inv');
    writeFileSync(wl, '{nope');
    expect(() => loadWatchlist(wl)).toThrow(wl);
    writeFileSync(wl, '{"version":2,"people":[]}');
    expect(() => loadWatchlist(wl)).toThrow(wl);
    writeFileSync(ds, '[]');
    expect(() => loadDiscoveries(ds)).toThrow(ds);
  });
});

describe('discoveries', () => {
  test('new candidates are new or have; a later run keeps statuses by sourceKey', () => {
    const { ds } = fresh('d');
    const a = cand('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    const b = cand('https://example.com/b', { transcriptSource: 'page' });
    const r1 = recordDiscovery(ds, 'lisa-su', { since: '2026-03-31', candidates: [a, b], have: new Set(['example.com/b']) }, new Date('2026-09-27T10:00:00Z'));
    expect(r1.candidates.map((c) => c.status)).toEqual(['new', 'have']);
    expect(r1.checkedAt).toBe('2026-09-27T10:00:00.000Z');

    setCandidateStatus(ds, 'lisa-su', 'https://youtu.be/aaaaaaaaaaa', { status: 'pulled', receipts: 9, pulledAt: '2026-09-27T10:05:00Z' });
    const c = cand('https://youtu.be/ccccccccccc');
    const r2 = recordDiscovery(ds, 'lisa-su', { since: '2026-03-31', candidates: [c, cand('https://youtu.be/aaaaaaaaaaa', { title: 'renamed' })], have: new Set() }, new Date('2026-09-28T10:00:00Z'));
    expect(r2.candidates.map((x) => [x.title, x.status, x.receipts])).toEqual([
      ['https://youtu.be/ccccccccccc', 'new', undefined],
      ['renamed', 'pulled', 9],
      ['https://example.com/b', 'have', undefined],
    ]);
    expect(r2.candidates[1]!.foundAt).toBe('2026-09-27T10:00:00.000Z');
    expect(findCandidate(ds, 'lisa-su', 'https://www.youtube.com/watch?v=aaaaaaaaaaa')!.status).toBe('pulled');
  });

  test('setCandidateStatus: failed keeps the error, a later success clears it; a stale pulling resets', () => {
    const { ds } = fresh('s');
    const a = cand('https://youtu.be/aaaaaaaaaaa');
    recordDiscovery(ds, 'x', { since: '2026-03-31', candidates: [a], have: new Set() });
    setCandidateStatus(ds, 'x', a.url, { status: 'failed', error: 'YouTube is busy' });
    expect(findCandidate(ds, 'x', a.url)).toMatchObject({ status: 'failed', error: 'YouTube is busy' });
    setCandidateStatus(ds, 'x', a.url, { status: 'pulling' });
    expect(findCandidate(ds, 'x', a.url)!.error).toBeUndefined();
    const again = recordDiscovery(ds, 'x', { since: '2026-03-31', candidates: [a], have: new Set() });
    expect(again.candidates[0]!.status).toBe('new');
    setCandidateStatus(ds, 'nobody', a.url, { status: 'pulled' });
    expect(() => setCandidateStatus(ds, 'x', a.url, { status: 'bogus' as never })).toThrow(/Unknown/);
  });
});
