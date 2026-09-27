// Neutral language: Receipts is a track record on public statements, never a
// finding about motive. Seed rows are checked by scripts/validate-seed.ts;
// model text (grade rationales, drift notes, ask answers) is checked here
// before it is stored or shown, and replaced with a plain sentence on a hit.

import type { Claim, FinalVerdict } from './types.ts';

/** Words that state or imply dishonesty or motive. */
export const LOADED_WORDS =
  /\b(lie[sd]?|liars?|lying|misled|mislead(?:s|ing)?|dishonest(?:y|ly)?|deceiv(?:e|ed|es|ing)|deceptive|broke (?:a|his|her|their|its) promises?|broken promises?)\b/i;

/** The first loaded word in `text`, or null when the text is neutral. */
export function loadedWord(text: string): string | null {
  return LOADED_WORDS.exec(text)?.[0] ?? null;
}

/** `text` when neutral, else `fallback()`. */
export function neutralOr(text: string, fallback: () => string): string {
  return loadedWord(text) === null ? text : fallback();
}

/** A plain rationale built from the verdict and dates alone. */
export function neutralRationale(c: Pick<Claim, 'targetDate'>, verdict: FinalVerdict, resolvedOn?: string): string {
  const by = c.targetDate ? ` by ${c.targetDate}` : '';
  const later = resolvedOn && c.targetDate && resolvedOn > c.targetDate ? ` It happened on ${resolvedOn}.` : '';
  switch (verdict) {
    case 'correct':
      return `The predicted outcome happened${by}. See the evidence links.`;
    case 'incorrect':
      return `The target was not met${by}.${later} See the evidence links.`;
    case 'partial':
      return `Part of the prediction came true${by} and part did not. See the evidence links.`;
    case 'unresolvable':
      return 'The available evidence does not settle whether this came true.';
    case 'too_early':
      return 'The outcome cannot be known yet.';
  }
}
