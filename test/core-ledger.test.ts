import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimId,
  claimsFor,
  dueClaims,
  emptyLedger,
  loadLedger,
  patchClaims,
  saveLedger,
  slugify,
  updateLedger,
  upsertClaims,
} from '../src/ledger.ts';
import type { Grading } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'receipts-core-ledger-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const grading: Grading = {
  verdict: 'incorrect',
  confidence: 0.9,
  rationale: 'Did not happen by the deadline.',
  evidence: [{ url: 'https://example.com/evidence' }],
  gradedAt: '2026-09-27T00:00:00Z',
  gradedBy: 'gpt-5',
};

describe('slugify', () => {
  test.each([
    ['Elon Musk', 'elon-musk'],
    ['  Sam   Altman ', 'sam-altman'],
    ["Conan O'Brien", 'conan-obrien'],
    ['Conan O’Brien', 'conan-obrien'],
    ['José Álvarez', 'jose-alvarez'],
    ['Jensen Huang (NVIDIA)', 'jensen-huang-nvidia'],
  ])('%p -> %p', (name, slug) => expect(slugify(name)).toBe(slug));
});

describe('claimId', () => {
  test('12 hex chars, stable under case, punctuation and spacing', () => {
    const a = claimId('elon-musk', '2019-04-22', 'Tesla will have 1M robotaxis in 2020.');
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(claimId('elon-musk', '2019-04-22', '  tesla WILL have 1M robotaxis in 2020 ')).toBe(a);
  });

  test('differs by person, date or wording', () => {
    const a = claimId('elon-musk', '2019-04-22', 'x');
    expect(claimId('sam-altman', '2019-04-22', 'x')).not.toBe(a);
    expect(claimId('elon-musk', '2019-04-23', 'x')).not.toBe(a);
    expect(claimId('elon-musk', '2019-04-22', 'y')).not.toBe(a);
  });
});

describe('load/save', () => {
  test('missing file -> empty ledger', () => {
    const l = loadLedger(join(dir, 'nope.json'));
    expect(l.version).toBe(1);
    expect(l.claims).toEqual([]);
  });

  test('round-trips, sorted by person then saidDate, atomically', () => {
    const path = join(dir, 'nested', 'ledger.json');
    const l = ledgerOf([
      makeClaim({ personSlug: 'sam-altman', saidDate: '2020-01-01', claim: 'b' }),
      makeClaim({ saidDate: '2021-01-01', claim: 'c' }),
      makeClaim({ saidDate: '2019-01-01', claim: 'a' }),
    ]);
    saveLedger(path, l);
    const back = loadLedger(path);
    expect(back.claims.map((c) => `${c.personSlug} ${c.saidDate}`)).toEqual([
      'elon-musk 2019-01-01',
      'elon-musk 2021-01-01',
      'sam-altman 2020-01-01',
    ]);
    expect(readFileSync(path, 'utf8')).toContain('\n  "claims": [');
    expect(readdirSync(join(dir, 'nested'))).toEqual(['ledger.json']);
    expect(l.claims[0]!.personSlug).toBe('sam-altman'); // input not reordered
  });

  test('rejects files that are not a ledger', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"claims": 3}');
    expect(() => loadLedger(bad)).toThrow('version 1');
    writeFileSync(bad, '{oops');
    expect(() => loadLedger(bad)).toThrow('not valid JSON');
  });
});

describe('updateLedger and patchClaims', () => {
  test('a long run merges its changes into what another process saved meanwhile', () => {
    const path = join(dir, 'race.json');
    const mine = makeClaim({ claim: 'Mine.' });
    const theirs = makeClaim({ claim: 'Theirs.' });
    saveLedger(path, ledgerOf([mine, theirs]));
    const snapshot = loadLedger(path);

    // Another process grades "theirs" while this run is busy.
    updateLedger(path, (l) => patchClaims(l, [{ ...theirs, verdict: 'incorrect', grading }], ['verdict', 'grading']));
    // This run records a GBrain row on "mine" from its old snapshot.
    const synced = { ...snapshot.claims.find((c) => c.id === mine.id)!, gbrain: { page: 'people/elon-musk', row: 3 } };
    const saved = updateLedger(path, (l) => patchClaims(l, [synced], ['gbrain', 'verdict']));

    expect(saved.claims.find((c) => c.id === theirs.id)).toMatchObject({ verdict: 'incorrect', grading });
    expect(saved.claims.find((c) => c.id === mine.id)).toMatchObject({ verdict: 'pending', gbrain: { row: 3 } });
    expect(loadLedger(path).claims).toEqual(saved.claims);
  });

  test('patchClaims skips unknown ids and never clears a field', () => {
    const c = makeClaim({ claim: 'x', verdict: 'incorrect', grading });
    const l = ledgerOf([c]);
    patchClaims(l, [{ ...c, grading: undefined }, makeClaim({ claim: 'other' })], ['grading']);
    expect(l.claims).toEqual([c]);
  });
});

describe('upsertClaims', () => {
  test('adds new claims and fills missing ids', () => {
    const l = emptyLedger();
    const { added, updated } = upsertClaims(l, [makeClaim({ id: '' })]);
    expect(added).toHaveLength(1);
    expect(updated).toHaveLength(0);
    expect(l.claims[0]!.id).toBe(claimId('elon-musk', '2019-04-22', l.claims[0]!.claim));
  });

  test('re-extraction never drops grading, drift or gbrain state', () => {
    const graded = makeClaim({
      verdict: 'incorrect',
      grading,
      drift: { label: 'first', note: 'First.' },
      gbrain: { page: 'people/elon-musk', row: 7, timelineWritten: true },
    });
    const l = ledgerOf([graded]);
    const fresh = makeClaim({ specificity: 5, extractedAt: '2026-09-27T01:00:00Z' });
    const { added, updated } = upsertClaims(l, [fresh]);
    expect(added).toHaveLength(0);
    expect(updated).toHaveLength(1);
    const c = l.claims[0]!;
    expect(c.specificity).toBe(5);
    expect(c.verdict).toBe('incorrect');
    expect(c.grading).toEqual(grading);
    expect(c.drift?.label).toBe('first');
    expect(c.gbrain).toEqual({ page: 'people/elon-musk', row: 7, timelineWritten: true });
  });

  test('a new grading replaces the verdict; gbrain fields merge', () => {
    const l = ledgerOf([makeClaim({ gbrain: { page: 'people/elon-musk', row: 7 } })]);
    upsertClaims(l, [makeClaim({ verdict: 'incorrect', grading, gbrain: { page: 'people/elon-musk', resolvedQuality: 'incorrect' } })]);
    expect(l.claims[0]!.verdict).toBe('incorrect');
    expect(l.claims[0]!.gbrain).toEqual({ page: 'people/elon-musk', row: 7, resolvedQuality: 'incorrect' });
  });

  test('seed origin and verified quotes are sticky; identical upserts are no-ops', () => {
    const l = ledgerOf([makeClaim({ origin: 'seed', quoteVerified: true })]);
    upsertClaims(l, [makeClaim({ origin: 'extracted', quoteVerified: false })]);
    expect(l.claims[0]!.origin).toBe('seed');
    expect(l.claims[0]!.quoteVerified).toBe(true);
    expect(upsertClaims(l, [l.claims[0]!])).toEqual({ added: [], updated: [] });
  });

  test('duplicates inside one batch collapse into one added claim', () => {
    const l = emptyLedger();
    const { added } = upsertClaims(l, [makeClaim(), makeClaim({ specificity: 2 })]);
    expect(added).toHaveLength(1);
    expect(l.claims).toHaveLength(1);
    expect(l.claims[0]!.specificity).toBe(2);
  });
});

describe('queries', () => {
  const l = ledgerOf([
    makeClaim({ claim: 'late', saidDate: '2019-01-01', targetDate: '2020-12-31' }),
    makeClaim({ claim: 'early', saidDate: '2018-01-01', targetDate: '2019-06-30' }),
    makeClaim({ claim: 'future', targetDate: '2030-01-01' }),
    makeClaim({ claim: 'no deadline', targetDate: undefined }),
    makeClaim({ claim: 'stance', type: 'stance', targetDate: '2019-01-01' }),
    makeClaim({ claim: 'graded', targetDate: '2019-01-01', verdict: 'incorrect', grading }),
    makeClaim({ claim: 'too early before', targetDate: '2019-02-01', verdict: 'too_early' }),
    makeClaim({ claim: 'today', targetDate: '2026-09-27' }),
    makeClaim({ claim: 'other person', personSlug: 'sam-altman', targetDate: '2020-01-01' }),
  ]);

  test('dueClaims: predictions past deadline, pending or too_early, earliest deadline first', () => {
    expect(dueClaims(l, '2026-09-27').map((c) => c.claim)).toEqual([
      'too early before',
      'early',
      'other person',
      'late',
      'today',
    ]);
  });

  test('dueClaims filters by person and can include graded ones', () => {
    expect(dueClaims(l, '2026-09-27', { personSlug: 'sam-altman' }).map((c) => c.claim)).toEqual(['other person']);
    expect(dueClaims(l, '2026-09-27', { includeGraded: true }).map((c) => c.claim)).toContain('graded');
  });

  test('claimsFor returns one person oldest first', () => {
    const cs = claimsFor(l, 'elon-musk');
    expect(cs.every((c) => c.personSlug === 'elon-musk')).toBe(true);
    expect(cs[0]!.claim).toBe('early');
    expect(claimsFor(l, 'nobody')).toEqual([]);
  });
});
