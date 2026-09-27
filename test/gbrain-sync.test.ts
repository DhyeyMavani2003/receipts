// GBrain adapter against test/fake-gbrain.ts: process plumbing (working
// directory, GBRAIN_HOME), syncing into a new brain, regrade warnings and
// disputed gradings. The real CLI is covered in e2e/.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GBrain } from '../src/gbrain.ts';
import type { Claim, Grading, Ledger } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

let dir: string;
let bin: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'receipts-fake-gbrain-'));
  bin = join(dir, 'gbrain');
  writeFileSync(bin, `#!/bin/sh\nexec bun ${JSON.stringify(join(import.meta.dir, 'fake-gbrain.ts'))} "$@"\n`);
  chmodSync(bin, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function brain(name: string): string {
  const home = join(dir, name);
  mkdirSync(home, { recursive: true });
  return home;
}

function calls(home: string): { args: string[]; cwd: string; home: string }[] {
  return (JSON.parse(readFileSync(join(home, 'fake-brain.json'), 'utf8')) as { calls: { args: string[]; cwd: string; home: string }[] }).calls;
}

function graded(verdict: Grading['verdict'], extra: Partial<Grading> = {}): Pick<Claim, 'verdict' | 'grading'> {
  return {
    verdict,
    grading: { verdict, confidence: 0.9, rationale: 'r', evidence: [{ url: 'https://news.example/e' }], gradedAt: '2026-01-01T00:00:00Z', gradedBy: 'gpt-5', ...extra },
  };
}

function sampleLedger(): Ledger {
  return ledgerOf([
    makeClaim({ claim: 'Robotaxis in 2020.', ...graded('incorrect') }),
    makeClaim({ claim: 'A second factory in 2021.', saidDate: '2019-05-01', targetDate: '2021-12-31' }),
  ]);
}

describe('GBrain adapter process plumbing', () => {
  test('runs gbrain from the temp dir, never the caller\'s folder, with GBRAIN_HOME passed explicitly', async () => {
    const home = brain('plumbing');
    const logs: string[] = [];
    await new GBrain({ bin, home, log: (l) => logs.push(l) }).syncClaims(sampleLedger());
    const seen = calls(home);
    expect(seen.length).toBeGreaterThan(3);
    // macOS aliases /var to /private/var, so compare resolved paths.
    expect(new Set(seen.map((c) => realpathSync(c.cwd)))).toEqual(new Set([realpathSync(tmpdir())]));
    expect(new Set(seen.map((c) => c.home))).toEqual(new Set([home]));
  }, 30_000);

  test('brainProblem: null when the brain answers, the reason when it does not', async () => {
    expect(await new GBrain({ bin, home: brain('probe') }).brainProblem()).toBeNull();
    expect(await new GBrain({ bin, home: join(dir, 'never-initialized') }).brainProblem()).toContain('No brain configured');
  }, 30_000);
});

describe('syncClaims', () => {
  test('a ledger synced into one brain is written again into a new one', async () => {
    const l = sampleLedger();
    await new GBrain({ bin, home: brain('a'), log: () => {} }).syncClaims(l);
    expect(l.claims.every((c) => c.gbrain?.row)).toBe(true);

    const fresh = brain('b');
    const progress: string[] = [];
    await new GBrain({ bin, home: fresh, log: () => {} }).syncClaims(l, { trackRecord: 'all', onProgress: (m) => progress.push(m) });
    expect(progress.join('\n')).toContain('was not in this brain; writing every claim again');
    const state = JSON.parse(readFileSync(join(fresh, 'fake-brain.json'), 'utf8')) as { pages: Record<string, unknown>; takes: Record<string, unknown[]> };
    expect(Object.keys(state.pages)).toEqual(['people/elon-musk']);
    expect(state.takes['people/elon-musk']).toHaveLength(2);
  }, 30_000);

  test('a regrade GBrain cannot take back is warned about on every sync; a disputed grading is never resolved', async () => {
    const home = brain('regrade');
    const logs: string[] = [];
    const gb = new GBrain({ bin, home, log: (m) => logs.push(m) });
    const l = sampleLedger();
    await gb.syncClaims(l);
    const missed = l.claims.find((c) => c.verdict === 'incorrect')!;
    expect(missed.gbrain?.resolvedQuality).toBe('incorrect');

    Object.assign(missed, graded('correct'));
    await gb.syncClaims(l);
    await gb.syncClaims(l);
    expect(logs.filter((m) => m.includes('already resolved as incorrect; the ledger says correct'))).toHaveLength(2);

    const open = l.claims.find((c) => c.verdict === 'pending')!;
    Object.assign(open, graded('unresolvable', { disputed: true }));
    await gb.syncClaims(l);
    expect(open.gbrain?.resolvedQuality).toBeUndefined();
    expect(calls(home).some((c) => c.args.includes('resolve') && c.args.includes(String(open.gbrain?.row)))).toBe(false);
  }, 30_000);
});

describe('claims that share one quote', () => {
  test('every claim split from one sentence gets its own timeline entry, take and resolution', async () => {
    const home = brain('shared-quote');
    const quote = "We're expecting Blackwell to ship in Q3 and the revenue to follow.";
    const l = ledgerOf([
      makeClaim({ claim: 'Blackwell ships in Q3 2024.', quote, saidDate: '2024-05-01', targetDate: '2024-09-30', topic: 'nvidia-blackwell', ...graded('correct') }),
      makeClaim({ claim: 'Blackwell revenue arrives in Q4 2024.', quote, saidDate: '2024-05-01', targetDate: '2024-12-31', topic: 'nvidia-revenue', ...graded('incorrect') }),
      makeClaim({ claim: 'Blackwell volume ramps in 2025.', quote, saidDate: '2024-05-01', targetDate: '2025-12-31', topic: 'nvidia-supply' }),
    ]);
    const progress: string[] = [];
    await new GBrain({ bin, home, log: () => {} }).syncClaims(l, { onProgress: (m) => progress.push(m) });
    expect(progress.join('\n')).not.toContain('not synced');
    expect(l.claims.every((c) => c.gbrain?.timelineWritten && c.gbrain.row)).toBe(true);
    expect(l.claims.filter((c) => c.gbrain?.resolvedQuality).map((c) => c.gbrain!.resolvedQuality).sort()).toEqual(['correct', 'incorrect']);
    const state = JSON.parse(readFileSync(join(home, 'fake-brain.json'), 'utf8')) as { timeline: { summary: string }[] };
    expect(state.timeline).toHaveLength(3);
    expect(state.timeline[0]!.summary).not.toContain('from this quote');
    expect(state.timeline[1]!.summary).toEndWith('(claim 2 of 3 from this quote)');
    expect(state.timeline[2]!.summary).toEndWith('(claim 3 of 3 from this quote)');
  }, 30_000);

  test('one claim gbrain rejects does not stop the rest of the person, and the track record is still written', async () => {
    const home = brain('one-bad-claim');
    const l = ledgerOf([
      makeClaim({ claim: 'FAKE_GBRAIN_REJECT this one.', saidDate: '2019-01-01', targetDate: '2020-12-31' }),
      makeClaim({ claim: 'Robotaxis in 2020.', ...graded('incorrect') }),
    ]);
    const progress: string[] = [];
    await expect(new GBrain({ bin, home, log: () => {} }).syncClaims(l, { onProgress: (m) => progress.push(m) })).rejects.toThrow('rejected by the fake');
    const good = l.claims.find((c) => c.claim === 'Robotaxis in 2020.')!;
    expect(good.gbrain?.row).toBeGreaterThan(0);
    expect(good.gbrain?.resolvedQuality).toBe('incorrect');
    expect(progress.join('\n')).toContain('track record refreshed');
    const state = JSON.parse(readFileSync(join(home, 'fake-brain.json'), 'utf8')) as { pages: Record<string, { content: string }> };
    expect(state.pages['people/elon-musk']!.content).toContain('receipts:track-record:begin');
  }, 30_000);
});
