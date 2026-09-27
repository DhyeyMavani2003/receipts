// Hedge words -> implied probability. Deterministic on purpose: the model
// reports which words the speaker used, code decides what they are worth,
// so Brier scores cannot be nudged after the fact.

export interface HedgeRow {
  p: number;
  phrases: readonly string[];
  note?: string;          // legend text for rows that are about framing, not words
}

/** The table behind impliedProbability(), in legend order (most to least confident). */
export const HEDGE_TABLE: readonly HedgeRow[] = [
  {
    p: 0.95,
    phrases: ['for sure', 'definitely', 'certainly', 'guarantee', '100%', 'no doubt', 'no doubt about it', 'without a doubt', 'absolutely', 'without question', 'completely obvious'],
  },
  { p: 0.9, phrases: ['very confident', 'highly confident', 'extremely likely', "I'm confident", 'feel confident'] },
  { p: 0.85, phrases: ['will', 'is going to'], note: 'plain future declarative, or no hedge at all' },
  { p: 0.75, phrases: ['very likely', 'expect', 'on track', 'fairly confident', 'the plan is', 'game plan'] },
  { p: 0.7, phrases: ['likely', 'probably', 'should'] },
  { p: 0.65, phrases: ['I think', 'I believe', 'my guess', "I'm guessing", 'I guess'] },
  { p: 0.55, phrases: ['I hope', 'hopefully', 'our hope is', 'aim to', 'goal is', 'aspirational', 'see if we can'] },
  { p: 0.5, phrases: ['50/50', 'coin flip', 'maybe'] },
  { p: 0.4, phrases: ['possibly', 'potentially', 'could', 'might', 'we may', 'it may', 'may see'] },
  { p: 0.25, phrases: ['unlikely', 'doubt'], note: 'about the event; a claim written as "X will not" gets 1 - p' },
  { p: 0.1, phrases: ['no chance', 'never going to'], note: 'about the event; a claim written as "X will not" gets 1 - p' },
];

/** Probability of a plain declarative ("will", or no hedge words at all). */
export const DEFAULT_PROBABILITY = 0.85;

export interface HedgeMatch {
  phrase: string;
  p: number;
}

// Hedges are copied verbatim from speech, so the table's written forms must
// also match their spoken forms: "a hundred percent" is "100%", "fifty-fifty" is "50/50".
function normalizeHedgeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\b(?:(?:a|one) )?hundred[ -]?(?:percent|per cent)\b/g, '100%')
    .replace(/\b(\d+(?:\.\d+)?) ?(?:percent|per cent)\b/g, '$1%')
    .replace(/\b(?:fifty|50)(?:[ -]|\/)(?:fifty|50)\b/g, '50/50')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// Longest phrase first, so "very likely" beats "likely" and "unlikely" is
// never read as "likely". Phrases match whole words ("will" must not fire
// inside "willing"), allowing a plain inflection ("expected", "guarantees").
const MATCHERS: { phrase: string; p: number; re: RegExp }[] = HEDGE_TABLE.flatMap(({ p, phrases }) =>
  phrases.map((phrase) => {
    const norm = escapeRegExp(normalizeHedgeText(phrase));
    const suffix = /[a-z]$/.test(phrase) ? '(?:s|d|ed)?' : '';
    return { phrase, p, re: new RegExp(`(?<![a-z0-9])${norm}${suffix}(?![a-z0-9])`) };
  }),
).sort((a, b) => b.phrase.length - a.phrase.length);

/** The longest table phrase found in `text`, or null. */
export function matchHedge(text: string): HedgeMatch | null {
  const norm = normalizeHedgeText(text);
  if (!norm) return null;
  const hit = MATCHERS.find((m) => m.re.test(norm));
  return hit ? { phrase: hit.phrase, p: hit.p } : null;
}

/** Round to the nearest 0.05 and clamp to [0.05, 0.95]. */
export function roundProbability(p: number): number {
  const stepped = Math.round(p * 20) / 20;
  return Math.min(0.95, Math.max(0.05, stepped));
}

/**
 * Implied probability of a claim from the hedge words used with it. When the
 * hedge has no table phrase, the claim text is checked too (the hedge can sit
 * inside the sentence: "it could happen next year"); otherwise the claim is a
 * plain declarative.
 */
export function impliedProbability(hedge: string, claimText?: string): number {
  const match = matchHedge(hedge) ?? (claimText ? matchHedge(claimText) : null);
  return roundProbability(match?.p ?? DEFAULT_PROBABILITY);
}

// Hedges below 0.5 describe the speaker betting against an event ("no chance
// the iPhone gets share"). Extraction writes those claims in the speaker's
// direction ("the iPhone will not get share"), so the claim's probability is
// the complement. Without this, Ballmer's "no chance" would score as a 10%
// bet on his own claim and his miss would look like good calibration.
const NEGATED_CLAIM = /\b(?:will not|won't|would not|wouldn't|is not going to|isn't going to|are not going to|aren't going to|not going to|never|no longer|cannot|can't|not)\b/i;

/** True when the claim sentence asserts that something will not happen. */
export function isNegatedClaim(claim: string): boolean {
  return NEGATED_CLAIM.test(claim.replace(/[‘’ʼ]/g, "'"));
}

/**
 * Probability that `claim` (as written) comes true, from the speaker's hedge
 * words: the table value, flipped to 1 - p when a below-even hedge sits on a
 * claim written in the negative.
 */
export function claimProbability(hedge: string, claim: string): number {
  const p = impliedProbability(hedge);
  if (matchHedge(hedge) && p < 0.5 && isNegatedClaim(claim)) return roundProbability(1 - p);
  return p;
}
