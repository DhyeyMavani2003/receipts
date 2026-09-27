import { describe, expect, test } from 'bun:test';
import { brier, latenessMultiplier, monthsBetween, outcomeOf, scoreAll, scorePerson } from '../src/score.ts';
import type { Claim, Grading, Verdict } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

let seq = 0;
function graded(verdict: Verdict, p: number, extra: Partial<Claim> = {}, resolvedOn?: string): Claim {
  const grading: Grading | undefined =
    verdict === 'pending'
      ? undefined
      : { verdict, confidence: 0.9, rationale: 'r', evidence: [], gradedAt: '2026-09-27T00:00:00Z', gradedBy: 'test', resolvedOn };
  return makeClaim({ claim: `${verdict} ${p} #${++seq}`, verdict, impliedProbability: p, grading, ...extra });
}

// A real GBrain run: `takes scorecard` on these five bets reported
// accuracy 0.25 and Brier 0.5225 (partial is excluded from both).
const GBRAIN_CASE: Claim[] = [
  graded('incorrect', 0.95),
  graded('correct', 0.75),
  graded('incorrect', 0.75),
  graded('partial', 0.95),
  graded('incorrect', 0.75),
];

describe('GBrain scorecard parity', () => {
  test('five-bet case: accuracy 0.25, Brier 0.5225', () => {
    const s = scorePerson(GBRAIN_CASE);
    expect(s.accuracy).toBe(0.25);
    expect(s.brier).toBeCloseTo(0.5225, 10);
    expect(brier(GBRAIN_CASE)).toBeCloseTo(0.5225, 10);
    expect(s.partial).toBe(1);
    expect(s.creditAccuracy).toBeCloseTo(1.5 / 5, 10);
  });
});

describe('outcomeOf / brier', () => {
  test('only correct and incorrect have outcomes', () => {
    expect(outcomeOf('correct')).toBe(1);
    expect(outcomeOf('incorrect')).toBe(0);
    for (const v of ['partial', 'unresolvable', 'too_early', 'pending'] as const) expect(outcomeOf(v)).toBeNull();
  });

  test('null without binary outcomes; stances are ignored', () => {
    expect(brier([])).toBeNull();
    expect(brier([graded('partial', 0.9), graded('pending', 0.9)])).toBeNull();
    expect(brier([graded('incorrect', 0.9, { type: 'stance' })])).toBeNull();
    expect(brier([graded('correct', 0.5)])).toBeCloseTo(0.25, 10);
  });
});

describe('monthsBetween', () => {
  test('exact day counts over the average month (30.4375 days)', () => {
    expect(monthsBetween('2019-04-22', '2020-04-22')).toBeCloseTo(366 / 30.4375, 10);
    expect(monthsBetween('2020-12-31', '2019-12-31')).toBeCloseTo(-366 / 30.4375, 10);
    // End-of-month edges are real days, not thirtieths: one day is one day.
    expect(monthsBetween('2025-12-31', '2026-01-01')).toBeCloseTo(1 / 30.4375, 10);
    expect(monthsBetween('2025-01-31', '2025-02-01')).toBeGreaterThan(0);
  });
});

describe('latenessMultiplier', () => {
  const late = (said: string, target: string, resolved: string, verdict: Verdict = 'correct') =>
    graded(verdict, 0.85, { saidDate: said, targetDate: target }, resolved);

  test('median of (resolved - said) / (target - said), in days', () => {
    const claims = [
      late('2019-01-01', '2020-01-01', '2021-01-01'), // 731/365
      late('2019-01-01', '2020-01-01', '2022-01-01'), // 1096/365
      late('2019-01-01', '2020-01-01', '2023-01-01'), // 1461/365
    ];
    expect(latenessMultiplier(claims)).toBeCloseTo(1096 / 365, 10);
    expect(latenessMultiplier(claims.slice(0, 2))).toBeCloseTo((731 + 1096) / 2 / 365, 10);
  });

  test('a prediction graded incorrect for missing its deadline, that happened later, counts', () => {
    // Tesla Semi: said 2017-11-16, promised 2019-12-31, production began 2022-10-06.
    const semi = late('2017-11-16', '2019-12-31', '2022-10-06', 'incorrect');
    expect(latenessMultiplier([semi])).toBeCloseTo(1785 / 775, 10);
    expect(latenessMultiplier([semi])!.toFixed(1)).toBe('2.3');
  });

  test('a one-day promise one day late is 2x, not skipped', () => {
    expect(latenessMultiplier([late('2025-01-31', '2025-02-01', '2025-02-02')])).toBe(2);
  });

  test('ignores on-time, never-happened, partial, undated and zero-length promises', () => {
    expect(
      latenessMultiplier([
        late('2019-01-01', '2020-01-01', '2019-06-01'),
        late('2019-01-01', '2020-01-01', '2020-01-01'),
        graded('incorrect', 0.85, { saidDate: '2019-01-01', targetDate: '2020-01-01' }),
        late('2019-01-01', '2020-01-01', '2021-01-01', 'partial'),
        graded('correct', 0.85, { saidDate: '2019-01-01', targetDate: undefined }, '2021-01-01'),
        graded('correct', 0.85, { saidDate: '2019-01-01', targetDate: '2020-01-01' }),
        late('2019-01-01', '2019-01-01', '2021-01-01'),
        late('2019-06-01', '2019-01-01', '2021-01-01'),
      ]),
    ).toBeNull();
  });
});

describe('scorePerson', () => {
  const claims = [
    ...GBRAIN_CASE,
    graded('unresolvable', 0.5),
    graded('too_early', 0.5),
    graded('pending', 0.5),
    graded('correct', 0.7, { topic: 'mars-landing' }),
    makeClaim({ claim: 'stance', type: 'stance', topic: 'ai-risk' }),
    makeClaim({ claim: 'drift a', type: 'stance', drift: { label: 'pushed_later', note: '' } }),
    makeClaim({ claim: 'drift b', drift: { label: 'goalposts_moved', note: '' } }),
    makeClaim({ claim: 'drift c', drift: { label: 'reversed', note: '' } }),
    makeClaim({ claim: 'drift d', drift: { label: 'softened', note: '' } }),
  ];
  const s = scorePerson(claims);

  test('counts claims, predictions and each verdict among predictions', () => {
    expect(s.personSlug).toBe('elon-musk');
    expect(s.person).toBe('Elon Musk');
    expect(s.claims).toBe(claims.length);
    expect(s.predictions).toBe(claims.length - 2);
    expect([s.correct, s.incorrect, s.partial, s.unresolvable, s.tooEarly]).toEqual([2, 3, 1, 1, 1]);
    expect(s.pending).toBe(4);
    expect(s.accuracy).toBe(0.4);
  });

  test('driftEvents counts pushed_later, goalposts_moved and reversed', () => {
    expect(s.driftEvents).toBe(3);
  });

  test('byTopic covers predictions only, biggest topic first', () => {
    expect(s.byTopic.map((t) => t.topic)).toEqual(['tesla-robotaxi', 'mars-landing']);
    expect(s.byTopic[1]).toEqual({ topic: 'mars-landing', predictions: 1, correct: 1, incorrect: 0, partial: 0, accuracy: 1 });
  });

  test('calibration buckets are 0.1 wide and put 0.7 in 0.7-0.8', () => {
    expect(s.calibration).toEqual([
      { bucket: '0.7-0.8', n: 4, predicted: (0.75 * 3 + 0.7) / 4, observed: 0.5 },
      { bucket: '0.9-1.0', n: 1, predicted: 0.95, observed: 0 },
    ]);
  });

  test('empty input gives an all-null score', () => {
    const e = scorePerson([]);
    expect(e.predictions).toBe(0);
    expect([e.accuracy, e.creditAccuracy, e.brier, e.latenessMultiplier]).toEqual([null, null, null, null]);
    expect(e.calibration).toEqual([]);
  });
});

describe('scoreAll', () => {
  test('one score per person, most predictions first', () => {
    const l = ledgerOf([
      makeClaim({ claim: 'a', personSlug: 'sam-altman', person: 'Sam Altman' }),
      makeClaim({ claim: 'b' }),
      makeClaim({ claim: 'c' }),
      makeClaim({ claim: 'd', personSlug: 'bill-gates', person: 'Bill Gates', type: 'stance' }),
    ]);
    expect(scoreAll(l).map((s) => [s.personSlug, s.predictions])).toEqual([
      ['elon-musk', 2],
      ['sam-altman', 1],
      ['bill-gates', 0],
    ]);
  });
});
