// Track-record math. accuracy and Brier match GBrain's `takes scorecard`
// exactly (src/core/takes-resolution.ts + the scorecard SQL): only
// correct/incorrect count, partial and unresolvable are reported separately.

import { daysBetween } from './drift.ts';
import type { Claim, Ledger, PersonScore, TopicScore, Verdict } from './types.ts';

const DRIFT_EVENT_LABELS = new Set(['pushed_later', 'goalposts_moved', 'reversed']);

export function outcomeOf(v: Verdict): 1 | 0 | null {
  if (v === 'correct') return 1;
  if (v === 'incorrect') return 0;
  return null;
}

function isPrediction(c: Claim): boolean {
  return c.type === 'prediction';
}

/** Predictions with a binary outcome, paired with it. */
function binaryOutcomes(claims: Claim[]): { p: number; o: 1 | 0 }[] {
  const out: { p: number; o: 1 | 0 }[] = [];
  for (const c of claims) {
    const o = outcomeOf(c.verdict);
    if (isPrediction(c) && o !== null) out.push({ p: c.impliedProbability, o });
  }
  return out;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

/** Mean squared error of impliedProbability against the outcome, over correct/incorrect predictions. */
export function brier(claims: Claim[]): number | null {
  return mean(binaryOutcomes(claims).map(({ p, o }) => (p - o) ** 2));
}

/** Average month length in days (365.25 / 12). */
export const DAYS_PER_MONTH = 30.4375;

/** Months from `from` to `to` (YYYY-MM-DD), from the exact day count. */
export function monthsBetween(from: string, to: string): number {
  return daysBetween(from, to) / DAYS_PER_MONTH;
}

/** A prediction whose outcome happened, but after its deadline: correct, or incorrect for missing it. */
export function cameTrueLate(c: Claim): boolean {
  const resolvedOn = c.grading?.resolvedOn;
  return (
    isPrediction(c) &&
    (c.verdict === 'correct' || c.verdict === 'incorrect') &&
    c.targetDate !== undefined &&
    resolvedOn !== undefined &&
    resolvedOn > c.targetDate
  );
}

/**
 * How many times longer than promised predictions that came true late took:
 * median of (resolvedOn - saidDate) / (targetDate - saidDate), in days. The
 * strict grader marks a late delivery incorrect and records when it happened,
 * so both verdicts count. 2.5 means it took 2.5x the promised time; null
 * when nothing qualifies.
 */
export function latenessMultiplier(claims: Claim[]): number | null {
  const ratios: number[] = [];
  for (const c of claims) {
    if (!cameTrueLate(c)) continue;
    const promised = daysBetween(c.saidDate, c.targetDate!);
    if (promised <= 0) continue;
    ratios.push(daysBetween(c.saidDate, c.grading!.resolvedOn!) / promised);
  }
  return median(ratios);
}

interface VerdictCounts {
  correct: number;
  incorrect: number;
  partial: number;
  unresolvable: number;
  tooEarly: number;
  pending: number;
}

function countVerdicts(predictions: Claim[]): VerdictCounts {
  const n = (v: Verdict) => predictions.filter((c) => c.verdict === v).length;
  return {
    correct: n('correct'),
    incorrect: n('incorrect'),
    partial: n('partial'),
    unresolvable: n('unresolvable'),
    tooEarly: n('too_early'),
    pending: n('pending'),
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function topicScores(predictions: Claim[]): TopicScore[] {
  return [...groupBy(predictions, (c) => c.topic)]
    .map(([topic, cs]) => {
      const { correct, incorrect, partial } = countVerdicts(cs);
      return { topic, predictions: cs.length, correct, incorrect, partial, accuracy: ratio(correct, correct + incorrect) };
    })
    .sort((a, b) => b.predictions - a.predictions || a.topic.localeCompare(b.topic));
}

// Integer bucket index so 0.7 lands in 0.7-0.8, not 0.6-0.7 (0.7 / 0.1 = 6.999...
// in floating point). GBrain does the same with NUMERIC casts. 1.0 joins the top bucket.
function bucketIndex(p: number): number {
  return Math.min(Math.floor(Math.round(p * 1000) / 100), 9);
}

function calibration(claims: Claim[]): PersonScore['calibration'] {
  const byBucket = groupBy(binaryOutcomes(claims), ({ p }) => String(bucketIndex(p)));
  return [...byBucket]
    .map(([idx, rows]) => ({ idx: Number(idx), rows }))
    .sort((a, b) => a.idx - b.idx)
    .map(({ idx, rows }) => ({
      bucket: `${(idx / 10).toFixed(1)}-${((idx + 1) / 10).toFixed(1)}`,
      n: rows.length,
      predicted: mean(rows.map((r) => r.p))!,
      observed: mean(rows.map((r) => r.o))!,
    }));
}

/** Score one person. `claims` must already be filtered to that person. */
export function scorePerson(claims: Claim[]): PersonScore {
  const predictions = claims.filter(isPrediction);
  const counts = countVerdicts(predictions);
  const { correct, incorrect, partial } = counts;
  return {
    personSlug: claims[0]?.personSlug ?? '',
    person: claims[0]?.person ?? '',
    claims: claims.length,
    predictions: predictions.length,
    ...counts,
    accuracy: ratio(correct, correct + incorrect),
    creditAccuracy: ratio(correct + 0.5 * partial, correct + incorrect + partial),
    brier: brier(claims),
    latenessMultiplier: latenessMultiplier(claims),
    driftEvents: claims.filter((c) => c.drift && DRIFT_EVENT_LABELS.has(c.drift.label)).length,
    byTopic: topicScores(predictions),
    calibration: calibration(claims),
  };
}

/** One score per person, most predictions first. */
export function scoreAll(l: Ledger): PersonScore[] {
  return [...groupBy(l.claims, (c) => c.personSlug).values()]
    .map(scorePerson)
    .sort((a, b) => b.predictions - a.predictions || a.person.localeCompare(b.person));
}
