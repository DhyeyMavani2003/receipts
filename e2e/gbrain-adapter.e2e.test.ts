// E2E for src/gbrain.ts against a real `gbrain` binary (GBRAIN_BIN or PATH);
// skipped when there is none. A fresh PGLite brain lives in a unique
// GBRAIN_HOME under the temp dir, so the user's own brain is never touched.
//
// Two people, six claims: predictions graded correct / incorrect / partial /
// unresolvable, one still open, and one stance. The GBrain scorecard must equal
// score.ts, and a second sync must change nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDrift, detectDrift } from '../src/drift.ts';
import { GBrain, TRACK_RECORD_BEGIN, TRACK_RECORD_END, takeClaimText, type TakeRow } from '../src/gbrain.ts';
import { claimsFor } from '../src/ledger.ts';
import { scorePerson } from '../src/score.ts';
import type { Claim, FinalVerdict, Ledger } from '../src/types.ts';
import { ledgerOf, makeClaim } from '../test/core-fixtures.ts';

const GBRAIN = process.env.GBRAIN_BIN || Bun.which('gbrain') || '';
const HAS_GBRAIN = GBRAIN !== '' && Bun.spawnSync([GBRAIN, '--version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const TIMEOUT = 240_000;

function graded(verdict: FinalVerdict, evidenceUrl: string): Pick<Claim, 'verdict' | 'grading'> {
  return {
    verdict,
    grading: {
      verdict,
      confidence: 0.8,
      rationale: 'Neutral test rationale.',
      evidence: [{ url: evidenceUrl, title: 'Evidence' }],
      gradedAt: '2026-01-01T00:00:00.000Z',
      gradedBy: 'human:test',
    },
  };
}

function janeClaim(over: Partial<Claim> & { claim: string }): Claim {
  return makeClaim({
    person: 'Jane Doe',
    personSlug: 'jane-doe',
    topic: 'robot-launch',
    source: { title: 'Example Podcast #12', url: 'https://www.youtube.com/watch?v=abc123', date: over.saidDate ?? '2019-04-22', kind: 'podcast', deepLink: 'https://www.youtube.com/watch?v=abc123&t=134s' },
    ...over,
  });
}

function samClaim(over: Partial<Claim> & { claim: string }): Claim {
  return makeClaim({
    person: 'Sam Roe',
    personSlug: 'sam-roe',
    topic: 'fusion-power',
    source: { title: 'Energy Keynote 2020', url: 'https://example.com/keynote', date: '2020-03-01', kind: 'keynote' },
    saidDate: '2020-03-01',
    ...over,
  });
}

function fixtureLedger(): Ledger {
  const l = ledgerOf([
    janeClaim({
      claim: 'The home robot ships to customers by the end of 2020.', quote: 'Definitely, we will ship the robot to customers next year',
      hedge: 'definitely', impliedProbability: 0.95, targetDate: '2020-12-31', ...graded('incorrect', 'https://example.com/robot-delay'),
    }),
    janeClaim({
      claim: 'The home robot ships to customers by the end of 2022.', quote: "I think we'll have it in homes by 2022",
      saidDate: '2021-02-01', hedge: 'I think', impliedProbability: 0.65, targetDate: '2022-12-31', ...graded('correct', 'https://example.com/robot-ships'),
    }),
    janeClaim({
      claim: 'A second robot factory | opens in 2021.', quote: 'We will open a second factory in 2021',
      topic: 'robot-factory', hedge: '', impliedProbability: 0.85, targetDate: '2021-12-31', ...graded('partial', 'https://example.com/factory'),
    }),
    janeClaim({
      claim: 'Home robots are the next computing platform.', quote: 'Home robots are the next platform, no question',
      type: 'stance', topic: 'robot-platform', hedge: 'no question', impliedProbability: 0.95, targetDate: undefined,
    }),
    samClaim({
      claim: 'A commercial fusion plant supplies the grid by 2024.', quote: 'I expect fusion on the grid by 2024',
      hedge: 'expect', impliedProbability: 0.75, targetDate: '2024-12-31', ...graded('incorrect', 'https://example.com/fusion-2025'),
    }),
    samClaim({
      claim: 'Fusion startups raise 10 billion dollars in 2021.', quote: 'Fusion will raise ten billion next year',
      topic: 'fusion-funding', hedge: 'will', impliedProbability: 0.85, targetDate: '2021-12-31', ...graded('unresolvable', 'https://example.com/fusion-funding'),
    }),
    samClaim({
      claim: 'Fusion is cheaper than solar by 2040.', quote: 'Fusion might beat solar on cost by 2040',
      topic: 'fusion-cost', hedge: 'might', impliedProbability: 0.4, targetDate: '2040-12-31', verdict: 'too_early',
    }),
  ]);
  return applyDrift(l, detectDrift(l));
}

describe.skipIf(!HAS_GBRAIN)('GBrain adapter against a fresh PGLite brain', () => {
  let home = '';
  let gb: GBrain;
  let ledger: Ledger;
  const logs: string[] = [];
  // gbrain inherits this process's env. A database URL would point it away from
  // the throwaway brain, and the OpenAI key (Bun loads .env) would let it try
  // network calls, so both are unset for the run and restored afterwards.
  const ISOLATED_VARS = ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'OPENAI_API_KEY'] as const;
  const savedEnv = new Map(ISOLATED_VARS.map((k) => [k, process.env[k]]));

  const cli = (args: string[]): string => {
    const r = Bun.spawnSync([GBRAIN, ...args], { cwd: home, env: { ...process.env, GBRAIN_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`gbrain ${args.join(' ')} exited ${r.exitCode}: ${r.stderr.toString().slice(-600)}`);
    return r.stdout.toString();
  };
  const takesOf = (slug: string) => gb.listTakes(slug);
  const byRow = (rows: TakeRow[]) => [...rows].sort((a, b) => a.row_num - b.row_num);

  beforeAll(() => {
    for (const k of ISOLATED_VARS) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), 'receipts-gba-'));
    cli(['init', '--pglite', '--non-interactive', '--no-embedding', '--content-root', join(home, 'content'), '--git']);
    gb = new GBrain({ bin: GBRAIN, home, cwd: home, log: (line) => logs.push(line) });
    ledger = fixtureLedger();
  }, TIMEOUT);

  afterAll(() => {
    for (const [k, v] of savedEnv) if (v !== undefined) process.env[k] = v;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('a missing page reads as null', async () => {
    expect(await gb.available()).toBe(true);
    expect(await gb.getPage('people/nobody-here')).toBeNull();
  }, TIMEOUT);

  test('dry run prints the planned commands and writes nothing', async () => {
    const dry = new GBrain({ bin: GBRAIN, home, cwd: home, dryRun: true, log: (line) => logs.push(line) });
    const before = JSON.stringify(ledger);
    logs.length = 0;
    await dry.syncClaims(ledger, { personSlug: 'sam-roe' });

    expect(JSON.stringify(ledger)).toBe(before);
    expect(logs.every((line) => line.startsWith('[dry-run] gbrain '))).toBe(true);
    expect(logs[0]).toContain('gbrain put people/sam-roe');
    expect(logs.filter((line) => line.includes(' timeline-add '))).toHaveLength(3);
    expect(logs.filter((line) => line.includes(' takes add '))).toHaveLength(3);
    expect(logs.filter((line) => line.includes(' takes resolve '))).toHaveLength(2);
    expect(logs.some((line) => line.includes("--row '<row from takes add>' --quality unresolvable"))).toBe(true);
    expect(await gb.getPage('people/sam-roe')).toBeNull();
  }, TIMEOUT);

  test('sync writes person pages, timeline entries, bet takes and resolutions', async () => {
    const progress: string[] = [];
    logs.length = 0;
    const out = await gb.syncClaims(ledger, { onProgress: (m) => progress.push(m) });
    expect(out).toBe(ledger);
    expect(logs).toEqual([]);

    for (const c of ledger.claims) {
      expect(c.gbrain?.page).toBe(`people/${c.personSlug}`);
      expect(c.gbrain?.timelineWritten).toBe(true);
      expect(c.gbrain?.row).toBeGreaterThan(0);
      const graded = c.type === 'prediction' && !['pending', 'too_early'].includes(c.verdict);
      expect(c.gbrain?.resolvedQuality).toBe(graded ? c.verdict : undefined);
    }

    for (const slug of ['jane-doe', 'sam-roe']) {
      const claims = claimsFor(ledger, slug);
      const rows = await takesOf(slug);
      expect(rows).toHaveLength(claims.length);
      for (const c of claims) {
        const row = rows.find((r) => r.row_num === c.gbrain?.row)!;
        expect(row.claim).toBe(takeClaimText(c));
        expect(row.kind).toBe(c.type === 'prediction' ? 'bet' : 'take');
        expect(row.holder).toBe(`people/${slug}`);
        expect(row.weight).toBeCloseTo(c.impliedProbability, 6);
        expect(row.resolved_quality).toBe(c.gbrain?.resolvedQuality ?? null);
      }
    }
    expect(progress.some((m) => m === 'people/jane-doe: created person page')).toBe(true);
  }, TIMEOUT);

  test('GBrain scorecard equals score.ts for each person', async () => {
    for (const slug of ['jane-doe', 'sam-roe']) {
      const score = scorePerson(claimsFor(ledger, slug));
      const card = (await gb.scorecard(slug))!;
      expect(card.correct).toBe(score.correct);
      expect(card.incorrect).toBe(score.incorrect);
      expect(card.partial).toBe(score.partial);
      expect(card.unresolvable_count).toBe(score.unresolvable);
      expect(card.total_bets).toBe(score.predictions);
      if (score.accuracy === null) expect(card.accuracy).toBeNull();
      else expect(card.accuracy as number).toBeCloseTo(score.accuracy, 9);
      // GBrain stores weights as float4, so Brier matches to about 7 digits.
      expect(card.brier as number).toBeCloseTo(score.brier!, 6);
    }
  }, TIMEOUT);

  test('person page: template, track record above the timeline, timeline entries, takes fence', async () => {
    const page = (await gb.getPage('people/jane-doe'))!;
    expect(page).toContain('# Jane Doe\n\n> Public figure tracked by Receipts');
    expect(page).toContain("## What They're Building\n[No data yet]");
    expect(page.split(TRACK_RECORD_BEGIN)).toHaveLength(2);
    expect(page.indexOf(TRACK_RECORD_END)).toBeLessThan(page.indexOf('<!-- timeline -->'));
    expect(page).toContain('- **Accuracy:** 50% (1 of 2 resolved correct/incorrect)');
    expect(page).toContain('- robot-launch: 2020-12-31 → 2022-12-31 (pushed later)');
    expect(page).toContain('<!--- gbrain:takes:begin -->');
    for (const c of claimsFor(ledger, 'jane-doe')) {
      expect(page).toContain(`- **${c.saidDate}** | manual — ${c.source.title} — "${c.quote}" ${c.source.deepLink}`);
    }
    expect(cli(['timeline', 'people/sam-roe'])).toContain('"I expect fusion on the grid by 2024" https://example.com/keynote');
  }, TIMEOUT);

  test('a second sync is a no-op', async () => {
    const before = await gb.readPage('people/jane-doe');
    const rowsBefore = byRow(await takesOf('jane-doe'));
    const ledgerBefore = JSON.stringify(ledger);
    const progress: string[] = [];
    await gb.syncClaims(ledger, { onProgress: (m) => progress.push(m) });

    expect(progress).toEqual([]);
    expect(JSON.stringify(ledger)).toBe(ledgerBefore);
    expect(await gb.readPage('people/jane-doe')).toEqual(before);
    expect(byRow(await takesOf('jane-doe'))).toEqual(rowsBefore);
  }, TIMEOUT);

  test('a sync from a ledger that lost its GBrain state adds no duplicates', async () => {
    const fresh = fixtureLedger();
    const rowsBefore = byRow(await takesOf('sam-roe'));
    const timelineBefore = cli(['timeline', 'people/sam-roe']);
    logs.length = 0;
    await gb.syncClaims(fresh, { personSlug: 'sam-roe' });

    expect(byRow(await takesOf('sam-roe'))).toEqual(rowsBefore);
    expect(cli(['timeline', 'people/sam-roe'])).toBe(timelineBefore);
    expect(claimsFor(fresh, 'sam-roe').map((c) => c.gbrain)).toEqual(claimsFor(ledger, 'sam-roe').map((c) => c.gbrain));
    expect(logs).toEqual([]);
  }, TIMEOUT);

  test('writeTrackRecord rewrites only its block; takes fence and timeline stay byte-for-byte', async () => {
    const before = (await gb.getPage('people/jane-doe'))!;
    const outside = (md: string) => md.slice(md.indexOf('# Jane Doe')).replace(/<!-- receipts:track-record:begin -->[\s\S]*?<!-- receipts:track-record:end -->/, '<BLOCK>');
    const cardBefore = await gb.scorecard('jane-doe');
    const partialScore = scorePerson(claimsFor(ledger, 'jane-doe').slice(0, 1));
    await gb.writeTrackRecord('jane-doe', partialScore, ['custom chain line']);

    const after = (await gb.getPage('people/jane-doe'))!;
    expect(after).not.toBe(before);
    expect(after).toContain('- custom chain line');
    expect(outside(after)).toBe(outside(before));
    expect(after.slice(after.indexOf('<!-- timeline -->'))).toBe(before.slice(before.indexOf('<!-- timeline -->')));
    expect(await gb.scorecard('jane-doe')).toEqual(cardBefore);

    // Unchanged block: no write, same revision.
    const rev = (await gb.readPage('people/jane-doe'))!.revision;
    await gb.writeTrackRecord('jane-doe', partialScore, ['custom chain line']);
    expect((await gb.readPage('people/jane-doe'))!.revision).toBe(rev);
  }, TIMEOUT);

  test('resolutions are immutable: same quality is fine, a different one is logged and skipped', async () => {
    const missed = claimsFor(ledger, 'jane-doe').find((c) => c.verdict === 'incorrect')!;
    logs.length = 0;
    expect(await gb.resolveTake(missed)).toBe(true);
    expect(logs).toEqual([]);
    expect(await gb.resolveTake({ ...missed, ...graded('correct', 'https://example.com/other') })).toBe(false);
    expect(logs.join('\n')).toContain('already resolved as incorrect');
    const row = (await takesOf('jane-doe')).find((r) => r.row_num === missed.gbrain?.row)!;
    expect(row.resolved_quality).toBe('incorrect');
  }, TIMEOUT);
});
