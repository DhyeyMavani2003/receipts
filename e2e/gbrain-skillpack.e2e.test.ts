// E2E for the GBrain skill pack. Needs a real `gbrain` binary (GBRAIN_BIN or
// PATH); skipped when there is none. Every gbrain call runs with a throwaway
// GBRAIN_HOME so the user's own brain is never touched.
//
// 1. `gbrain skillpack doctor . --quick --json` must score the pack 10/10.
// 2. The manual path the skills document (person page template, timeline-add,
//    takes add --kind bet, takes resolve --quality, takes scorecard, the
//    track-record block round-trip) must work against a fresh PGLite brain.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACK_ROOT = join(import.meta.dir, '..');
const GBRAIN = process.env.GBRAIN_BIN || Bun.which('gbrain') || '';
const HAS_GBRAIN = GBRAIN !== '' && gbrainRuns();

const SLUG = 'people/jane-example';
const BEGIN = '<!-- receipts:track-record:begin -->';
const END = '<!-- receipts:track-record:end -->';

interface Run { code: number; stdout: string; stderr: string }

interface DoctorResult {
  schema_version: string;
  pack_name: string;
  score: number;
  max_score: number;
  tier_eligibility: string;
  dimensions: { name: string; category: 'core' | 'badge'; passed: boolean; detail: string }[];
}

interface Scorecard {
  total_bets: number;
  resolved: number;
  correct: number;
  incorrect: number;
  accuracy: number | null;
  brier: number | null;
  unresolvable_count?: number;
}

interface TakeRow { row_num: number; kind: string; holder: string; weight: number; resolved_quality: string | null }

function gbrainRuns(): boolean {
  try {
    return Bun.spawnSync([GBRAIN, '--version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
  } catch {
    return false;
  }
}

function isolatedEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'DATABASE_URL') env[key] = value;
  }
  env.GBRAIN_HOME = home;
  return env;
}

function gbrain(home: string, args: string[], stdin?: string): Run {
  const proc = Bun.spawnSync([GBRAIN, ...args], {
    env: isolatedEnv(home),
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function ok(run: Run): string {
  if (run.code !== 0) throw new Error(`gbrain exited ${run.code}: ${run.stderr.slice(-600)}`);
  return run.stdout;
}

function addedRow(stdout: string): number {
  const row = stdout.match(/Added take #(\d+)/)?.[1];
  if (!row) throw new Error(`no "Added take #N" in: ${stdout}`);
  return Number(row);
}

/** The create-only person template exactly as receipts-ingest SKILL.md documents it. */
function personTemplate(name: string): string {
  const skill = readFileSync(join(PACK_ROOT, 'skills/receipts-ingest/SKILL.md'), 'utf-8');
  const template = skill.match(/cat <<'EOF' \| gbrain put people\/<slug>\n([\s\S]*?)\nEOF/)?.[1];
  if (!template) throw new Error('person template not found in receipts-ingest SKILL.md');
  return template.replaceAll('<Full Name>', name) + '\n';
}

/** Insert or replace the track-record block right after the page's summary quote. */
function withTrackRecord(content: string, block: string): string {
  const fenced = `${BEGIN}\n${block}\n${END}`;
  if (content.includes(BEGIN)) {
    return content.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), fenced);
  }
  return content.replace(/^(> .*\n)/m, `$1\n${fenced}\n`);
}

describe.skipIf(!HAS_GBRAIN)('gbrain skillpack doctor', () => {
  let home = '';
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'receipts-doctor-')); });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test('scores the receipts pack 10/10 with every core dimension passing', () => {
    const run = gbrain(home, ['skillpack', 'doctor', PACK_ROOT, '--quick', '--json']);
    const result = JSON.parse(run.stdout) as DoctorResult;
    const failing = (category: 'core' | 'badge') =>
      result.dimensions.filter((d) => d.category === category && !d.passed).map((d) => `${d.name}: ${d.detail}`);

    expect(result.schema_version).toBe('skillpack-doctor-v1');
    expect(result.pack_name).toBe('receipts');
    expect(result.dimensions.filter((d) => d.category === 'core')).toHaveLength(5);
    expect(failing('core')).toEqual([]);
    expect(failing('badge')).toEqual([]);
    expect(result.score).toBe(result.max_score);
    expect(result.tier_eligibility).toBe('endorsed');
  }, 60_000);
});

describe.skipIf(!HAS_GBRAIN)('manual path against a throwaway brain', () => {
  let home = '';

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'receipts-brain-'));
    ok(gbrain(home, ['init', '--pglite', '--non-interactive', '--no-embedding',
      '--content-root', join(home, 'content'), '--git']));
  }, 180_000);

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test('ingest → grade → scorecard → track record, exactly as the skills document', () => {
    // receipts-ingest step 4: missing page, then the create-only template.
    expect(gbrain(home, ['get', SLUG]).code).not.toBe(0);
    ok(gbrain(home, ['put', SLUG], personTemplate('Jane Example')));
    expect(ok(gbrain(home, ['get', SLUG]))).toContain('# Jane Example');

    // Step 5: timeline entry with the verbatim quote and deep link in the summary.
    const quote = 'Definitely, we will ship the robot to customers next year';
    const link = 'https://www.youtube.com/watch?v=abc123&t=134s';
    ok(gbrain(home, ['timeline-add', SLUG, '2019-04-22', `Example Podcast #12 — "${quote}" ${link}`,
      '--detail', 'receipts: type=prediction topic=robot-launch due=2020-12-31 hedge="definitely" p=0.95']));

    // Step 6: one take per claim; holder = the speaker, weight from the hedge table.
    const addBet = (claim: string, weight: string, since: string) => addedRow(ok(gbrain(home, [
      'takes', 'add', SLUG, '--claim', claim, '--kind', 'bet', '--who', SLUG, '--weight', weight,
      '--source', `Example Podcast #12 2019-04-22 ${link}`, '--since', since,
    ])));
    const missed = addBet('Robot ships to customers by 2020-12-31 (deadline 2020-12-31)', '0.95', '2019-04');
    const hit = addBet('Second factory opens by 2021-12-31 (deadline 2021-12-31)', '0.65', '2019-04');
    const murky = addBet('Private benchmark passed by 2023-06-30 (deadline 2023-06-30)', '0.5', '2019-04');
    ok(gbrain(home, ['takes', 'add', SLUG, '--claim', 'Home robots are the next platform', '--kind', 'take',
      '--who', SLUG, '--weight', '0.65', '--source', `Example Podcast #12 2019-04-22 ${link}`, '--since', '2019-04']));

    // receipts-grade step 4: verdicts, including unresolvable; resolutions are immutable.
    const resolve = (row: number, quality: string) => gbrain(home, ['takes', 'resolve', SLUG, '--row', String(row),
      '--quality', quality, '--evidence', 'https://example.com/evidence', '--by', 'receipts']);
    ok(resolve(missed, 'incorrect'));
    ok(resolve(hit, 'correct'));
    ok(resolve(murky, 'unresolvable'));
    expect(resolve(missed, 'correct').code).not.toBe(0);

    // receipts-ask step 2: the scorecard the answer is built from.
    const card = JSON.parse(ok(gbrain(home, ['takes', 'scorecard', SLUG, '--json']))) as Scorecard;
    expect(card).toMatchObject({ total_bets: 3, resolved: 2, correct: 1, incorrect: 1, accuracy: 0.5, unresolvable_count: 1 });
    expect(card.brier ?? NaN).toBeCloseTo(((0.95 - 0) ** 2 + (0.65 - 1) ** 2) / 2, 4);

    const bets = JSON.parse(ok(gbrain(home, ['takes', SLUG, '--kind', 'bet', '--json']))) as TakeRow[];
    expect(bets).toHaveLength(3);
    for (const bet of bets) {
      expect(bet.holder).toBe(SLUG);
      expect(bet.resolved_quality).not.toBeNull();
    }
    expect(ok(gbrain(home, ['timeline', SLUG]))).toContain(quote);

    // receipts-grade step 5: rewrite only the track-record block, keep every take.
    const page = JSON.parse(ok(gbrain(home, ['get', SLUG, '--include-content', '--json']))) as { content: string; revision: string };
    const updated = withTrackRecord(page.content, '**Track record on public statements:** 1 of 2 graded predictions correct.');
    ok(gbrain(home, ['put', SLUG, '--expected-revision', page.revision], updated));

    const after = ok(gbrain(home, ['get', SLUG]));
    expect(after.split(BEGIN)).toHaveLength(2);
    expect(after.indexOf(BEGIN)).toBeLessThan(after.indexOf('## Timeline'));
    expect(after).toContain(quote);
    expect(JSON.parse(ok(gbrain(home, ['takes', SLUG, '--json']))) as TakeRow[]).toHaveLength(4);
  }, 180_000);
});
