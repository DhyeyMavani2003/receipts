// The committed seed file: built from data/seed/parts, valid against the
// seed rules, and answered offline by the seed drift fixtures. Plus the
// validator's own rules on broken claims.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildSeed } from '../scripts/build-seed.ts';
import { loadSeedLedger, SEED_DRIFT_MODEL } from '../scripts/make-seed-drift-fixtures.ts';
import { checkClaim, isProbabilityStep, validateSeed } from '../scripts/validate-seed.ts';
import { refineDrift } from '../src/drift.ts';
import { ReplayLLM } from '../src/llm/replay.ts';
import type { Claim } from '../src/types.ts';

const ROOT = join(import.meta.dir, '..');
const SEED = join(ROOT, 'data', 'seed', 'predictions.json');
const TODAY = '2026-09-27';

function seedClaims(): Claim[] {
  return JSON.parse(readFileSync(SEED, 'utf8')).claims;
}

describe('data/seed/predictions.json', () => {
  test('is exactly what scripts/build-seed.ts makes from the parts', () => {
    expect(buildSeed().seed).toEqual(JSON.parse(readFileSync(SEED, 'utf8')));
  });

  test('passes the validator with no errors', () => {
    const r = validateSeed(JSON.parse(readFileSync(SEED, 'utf8')), TODAY);
    expect(r.errors).toEqual([]);
    expect(r.claims).toBeGreaterThanOrEqual(30);
    expect(r.graded).toBeGreaterThan(20);
  });

  test('has correct predictions too, not only misses', () => {
    const verdicts = seedClaims().map((c) => c.verdict);
    expect(verdicts.filter((v) => v === 'correct').length).toBeGreaterThanOrEqual(5);
    expect(verdicts.filter((v) => v === 'incorrect').length).toBeGreaterThanOrEqual(5);
  });

  test('seed drift fixtures replay every multi-claim chain', async () => {
    const warnings: string[] = [];
    const m = await refineDrift(loadSeedLedger(SEED), new ReplayLLM(join(ROOT, 'fixtures', 'llm')), { onWarning: (w) => warnings.push(w) });
    expect(warnings).toEqual([]);
    const moon = seedClaims().find((c) => c.personSlug === 'elon-musk' && c.saidDate === '2026-02-08')!;
    expect(m.get(moon.id)?.label).toBe('goalposts_moved');
    expect(m.get(moon.id)?.note).toContain('Deadline moved from 2026-12-31 to 2036-02-08.');
    expect(SEED_DRIFT_MODEL.startsWith('human:')).toBe(true);
  });
});

describe('validator rules', () => {
  const good = (): Claim => structuredClone(seedClaims().find((c) => c.verdict === 'correct')!);
  const errorsOf = (c: unknown) => checkClaim(c, 0, TODAY).errors.join('\n');

  test('a real seed claim is clean', () => {
    expect(checkClaim(good(), 0, TODAY).errors).toEqual([]);
  });

  test('ids must be claimId() of slug, date and claim text', () => {
    expect(errorsOf({ ...good(), id: '' })).toContain('id is missing');
    expect(errorsOf({ ...good(), claim: `${good().claim} Changed.` })).toContain('does not match claimId()');
  });

  test('a quote must be the speaker\'s own words, not a reporter\'s sentence', () => {
    const quote = 'AI could wipe out half of all entry-level white-collar jobs, Amodei told us.';
    expect(errorsOf({ ...good(), quote })).toContain("reporter's attribution");
    expect(errorsOf({ ...good(), quote: 'Robotaxis will be everywhere next year, he said.' })).toContain("reporter's attribution");
    const named = checkClaim({ ...good(), person: 'Dario Amodei', personSlug: 'dario-amodei', quote: 'Amodei expects half of jobs to go.' }, 0, TODAY);
    expect(named.warnings.join('\n')).toContain('names Amodei in the third person');
  });

  test('dates, probability steps and specificity', () => {
    expect(errorsOf({ ...good(), saidDate: '2024-02-30' })).toContain('saidDate "2024-02-30" is not a YYYY-MM-DD date');
    expect(errorsOf({ ...good(), impliedProbability: 0.72 })).toContain('is not a 0.05 step');
    expect(errorsOf({ ...good(), specificity: 7 })).toContain('specificity must be an integer 1-5');
    expect(errorsOf({ ...good(), targetDate: undefined })).toContain('a prediction needs a targetDate');
    expect(isProbabilityStep(0.05)).toBe(true);
    expect(isProbabilityStep(0.7)).toBe(true);
    expect(isProbabilityStep(0.97)).toBe(false);
  });

  test('verdict and grading must agree, and graded claims need evidence URLs', () => {
    const c = good();
    expect(errorsOf({ ...c, verdict: 'pending' })).toContain('a pending claim must not carry a grading');
    expect(errorsOf({ ...c, verdict: 'incorrect' })).toContain('grading.verdict correct differs from verdict incorrect');
    expect(errorsOf({ ...c, grading: { ...c.grading!, evidence: [] } })).toContain('needs at least one evidence URL');
    expect(errorsOf({ ...c, grading: { ...c.grading!, evidence: [{ url: 'not a url' }] } })).toContain('evidence[0].url is not an http(s) URL');
    expect(errorsOf({ ...c, grading: undefined })).toContain('there is no grading');
    expect(errorsOf({ ...c, grading: { ...c.grading!, gradedBy: 'gpt-5' } })).toContain('gradedBy must be "human:seed"');
  });

  test('neutral language: loaded words are errors', () => {
    const c = good();
    expect(errorsOf({ ...c, grading: { ...c.grading!, rationale: 'He lied about the date.' } })).toContain('loaded wording ("lied")');
  });

  test('duplicate ids across the file are errors', () => {
    const c = good();
    expect(validateSeed({ version: 1, claims: [c, c] }, TODAY).errors.join('\n')).toContain('duplicate id');
    expect(validateSeed({ claims: [] }, TODAY).errors[0]).toContain('"version": 1');
  });
});
