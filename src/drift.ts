// How a person's story moves on one topic. Deadline slips are arithmetic
// (code); whether the goalposts moved, the stance reversed, or the claim got
// bigger or more hedged is judgment (model). A measured slip is never undone
// by the model; see mergeTransition() for the exact precedence.

import { z } from 'zod';
import type { LLM } from './llm/provider.ts';
import { neutralOr } from './neutral.ts';
import type { Claim, DriftInfo, DriftLabel, Ledger } from './types.ts';

export interface DriftChain {
  personSlug: string;
  topic: string;
  claims: Claim[];   // saidDate ascending
}

/** Deadline moves of at least this many days count as a slip. */
export const SLIP_DAYS = 60;

export const TRANSITION_LABELS = [
  'reaffirmed',
  'pushed_later',
  'pulled_earlier',
  'goalposts_moved',
  'reversed',
  'escalated',
  'softened',
] as const satisfies readonly Exclude<DriftLabel, 'first'>[];
type TransitionLabel = (typeof TRANSITION_LABELS)[number];

export const zDriftLabels = z.object({
  transitions: z.array(
    z.object({
      claimId: z.string(),
      label: z.enum(TRANSITION_LABELS),
      note: z.string(),
    }),
  ),
});
export type DriftLabelsOutput = z.infer<typeof zDriftLabels>;

// ---- Chains --------------------------------------------------------------

function byDateThenId(a: Claim, b: Claim): number {
  return a.saidDate.localeCompare(b.saidDate) || a.id.localeCompare(b.id);
}

/** One chain per (person, topic), claims oldest first. */
export function chains(l: Ledger): DriftChain[] {
  const groups = new Map<string, DriftChain>();
  for (const c of l.claims) {
    const key = `${c.personSlug}\u0000${c.topic}`;
    const chain = groups.get(key) ?? { personSlug: c.personSlug, topic: c.topic, claims: [] };
    chain.claims.push(c);
    groups.set(key, chain);
  }
  return [...groups.values()]
    .map((ch) => ({ ...ch, claims: [...ch.claims].sort(byDateThenId) }))
    .sort((a, b) => a.personSlug.localeCompare(b.personSlug) || a.topic.localeCompare(b.topic));
}

// ---- Deterministic labels ------------------------------------------------

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!) / 86_400_000;
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/**
 * Two claims said on one day are siblings: said together, so neither moved
 * the other. The date decides, not the URL: one page can carry statements
 * from several dates, and the demo ingests one transcript under two dates.
 */
function sameOccasion(a: Claim, b: Claim): boolean {
  return a.saidDate === b.saidDate;
}

/** Claims said on an earlier occasion than claim `i`, newest occasion last. */
function earlierOccasions(claims: Claim[], i: number): Claim[] {
  const cur = claims[i]!;
  return claims.slice(0, i).filter((c) => c.saidDate < cur.saidDate && !sameOccasion(c, cur));
}

/** The dated claims of the most recent earlier occasion that gave a deadline. */
function previousDeadlines(earlier: Claim[]): Claim[] {
  const dated = earlier.filter((c) => c.targetDate);
  const last = dated.at(-1)?.saidDate;
  return last === undefined ? [] : dated.filter((c) => c.saidDate === last);
}

function firstInfo(c: Claim): DriftInfo {
  return c.targetDate
    ? { label: 'first', note: `First recorded claim on this topic, with a deadline of ${c.targetDate}.` }
    : { label: 'first', note: 'First recorded claim on this topic.' };
}

// The earlier deadline closest to this one: the most conservative reading of a slip.
function closest(candidates: Claim[], to: string): Claim {
  return candidates.reduce((best, c) => (Math.abs(daysBetween(c.targetDate!, to)) < Math.abs(daysBetween(best.targetDate!, to)) ? c : best));
}

/**
 * Label claim `i` (i >= 1) of a chain against earlier occasions. Claims from
 * the same episode or day never measure each other. A deadline that came
 * true is a milestone met, not one that moved, so no slip is measured
 * against it.
 */
export function transitionInfo(claims: Claim[], i: number): DriftInfo {
  const cur = claims[i]!;
  const earlier = earlierOccasions(claims, i);
  if (earlier.length === 0) return firstInfo(cur);
  const previousDated = cur.targetDate ? previousDeadlines(earlier) : [];
  if (!cur.targetDate || previousDated.length === 0) {
    return { label: 'reaffirmed', previousClaimId: earlier.at(-1)!.id, note: 'Restated the claim; no earlier deadline to compare.' };
  }
  const to = cur.targetDate;
  const open = previousDated.filter((c) => c.verdict !== 'correct');
  if (open.length === 0) {
    const met = closest(previousDated, to);
    return { label: 'reaffirmed', previousClaimId: met.id, note: `The earlier deadline (${met.targetDate}) was met; this sets a new one, ${to}.` };
  }
  const prev = closest(open, to);
  const from = prev.targetDate!;
  const shift = daysBetween(from, to);
  const previousClaimId = prev.id;
  if (shift >= SLIP_DAYS) return { label: 'pushed_later', previousClaimId, note: `Deadline moved from ${from} to ${to}.` };
  if (shift <= -SLIP_DAYS) return { label: 'pulled_earlier', previousClaimId, note: `Deadline moved earlier, from ${from} to ${to}.` };
  const note = from === to ? `Restated with the same deadline, ${to}.` : `Restated with a deadline of ${to} (previously ${from}).`;
  return { label: 'reaffirmed', previousClaimId, note };
}

function chainDrift(chain: DriftChain): [string, DriftInfo][] {
  return chain.claims.map((c, i) => [c.id, i === 0 ? firstInfo(c) : transitionInfo(chain.claims, i)]);
}

/** Deterministic drift label for every claim in the ledger, by claim id. */
export function detectDrift(l: Ledger): Map<string, DriftInfo> {
  return new Map(chains(l).flatMap(chainDrift));
}

// ---- Model refinement ----------------------------------------------------

export const DRIFT_SYSTEM = `You compare what one public figure said about one topic at different times.
You get their claims in date order. For each claim after the first, label the change from the claim before it:
- reaffirmed: same claim again.
- pushed_later / pulled_earlier: same claim, deadline moved (the code already measured deadlines; copy its label unless the claim itself changed).
- goalposts_moved: the definition of success changed (e.g. Mars landing became Moon landing, AGI redefined).
- reversed: now says the opposite.
- escalated: a clearly stronger or bigger version of the claim.
- softened: a clearly weaker or more hedged version of the claim.
Compare only the speaker's own words. Whether a claim came true is not your concern here.
Write one neutral sentence per step describing what changed, e.g. "Target changed from a Mars landing to a Moon landing."
Never state or imply motive or dishonesty. Use each claimId exactly as given.`;

function describeClaim(c: Claim, det: DriftInfo | undefined): string {
  const lines = [
    `claimId: ${c.id}`,
    `said: ${c.saidDate} (${c.source.title})`,
    `deadline: ${c.targetDate ?? 'none'}`,
    `hedge: "${c.hedge}" (p=${c.impliedProbability})`,
    `quote: "${c.quote}"`,
    `claim: ${c.claim}`,
  ];
  if (det) lines.push(`code label: ${det.label} (${det.note})`);
  return lines.join('\n');
}

/** User prompt for one chain. Deterministic, so replay fixture keys stay stable. */
export function driftUserPrompt(chain: DriftChain, det: Map<string, DriftInfo>): string {
  const steps = chain.claims.map((c, i) => `#${i + 1}\n${describeClaim(c, i === 0 ? undefined : det.get(c.id))}`);
  return [
    `Speaker: ${chain.claims[0]?.person ?? chain.personSlug}`,
    `Topic: ${chain.topic}`,
    `Label every claim after #1 (${chain.claims.length - 1} transitions).`,
    '',
    steps.join('\n\n'),
  ].join('\n');
}

const JUDGMENT_LABELS = new Set<DriftLabel>(['goalposts_moved', 'reversed', 'escalated', 'softened']);
const CLAIM_CHANGE_LABELS = new Set<DriftLabel>(['goalposts_moved', 'reversed']);
const SLIP_LABELS = new Set<DriftLabel>(['pushed_later', 'pulled_earlier']);

/**
 * Combine the code label with the model's. The model may only add judgment
 * labels. Over a measured slip, only a change to the claim itself
 * (goalposts_moved, reversed) wins, and the slip sentence is kept in the
 * note; escalated/softened can only upgrade a 'reaffirmed' step.
 */
export function mergeTransition(det: DriftInfo, label: TransitionLabel, note: string, labeledBy?: string): DriftInfo {
  // 'first' marks a claim with no earlier occasion to compare with (siblings from one episode included).
  if (det.label === 'first' || !JUDGMENT_LABELS.has(label)) return det;
  const slipped = SLIP_LABELS.has(det.label);
  if (slipped && !CLAIM_CHANGE_LABELS.has(label)) return det;
  const plainNote = `Labeled ${label.replaceAll('_', ' ')} relative to the previous claim.`;
  const modelNote = neutralOr(note.trim(), () => plainNote) || plainNote;
  const keepSlipNote = slipped && !mentionsAllDates(modelNote, det.note);
  const merged: DriftInfo = { ...det, label, note: keepSlipNote ? `${modelNote} ${det.note}` : modelNote };
  if (labeledBy) merged.labeledBy = labeledBy;
  return merged;
}

function mentionsAllDates(text: string, source: string): boolean {
  return (source.match(/\d{4}-\d{2}-\d{2}/g) ?? []).every((d) => text.includes(d));
}

function isTransitionLabel(x: unknown): x is TransitionLabel {
  return typeof x === 'string' && (TRANSITION_LABELS as readonly string[]).includes(x);
}

// The mock and replay providers do not re-validate, so filter defensively:
// unknown ids, the chain's first claim, and bad labels are dropped.
function validTransitions(chain: DriftChain, data: unknown): Map<string, { label: TransitionLabel; note: string }> {
  const allowed = new Set(chain.claims.slice(1).map((c) => c.id));
  const out = new Map<string, { label: TransitionLabel; note: string }>();
  const rows = (data as Partial<DriftLabelsOutput> | null)?.transitions;
  if (!Array.isArray(rows)) return out;
  for (const t of rows) {
    if (!t || !allowed.has(t.claimId) || !isTransitionLabel(t.label) || out.has(t.claimId)) continue;
    out.set(t.claimId, { label: t.label, note: typeof t.note === 'string' ? t.note : '' });
  }
  return out;
}

async function refineChain(chain: DriftChain, det: Map<string, DriftInfo>, llm: LLM): Promise<[string, DriftInfo][]> {
  const res = await llm.json({
    schemaName: 'drift_labels',
    schema: zDriftLabels,
    system: DRIFT_SYSTEM,
    user: driftUserPrompt(chain, det),
    role: 'general',
  });
  const model = validTransitions(chain, res.data);
  return chain.claims.map((c) => {
    const base = det.get(c.id)!;
    const m = model.get(c.id);
    // Who labeled it, not how it arrived: a replayed answer keeps its recorded labeler.
    return [c.id, m ? mergeTransition(base, m.label, m.note, res.model.replace(/^replay:/, '')) : base];
  });
}

/** Whether the chain has anything for judgment to compare: claims from at least two occasions. */
export function hasTransitions(chain: DriftChain): boolean {
  return chain.claims.some((c, i) => i > 0 && earlierOccasions(chain.claims, i).length > 0);
}

export interface RefineDriftOptions {
  personSlug?: string;
  onWarning?: (message: string) => void;
  /**
   * The curated labels (a replay of fixtures/llm). A chain made only of seed
   * claims is labeled from it first, so a live run never spends a model call
   * on the seed or replaces its hand-written labels; the live model answers
   * only when no curated label was recorded for the chain.
   */
  curated?: LLM;
  /** Let the model relabel seed claims too (their curated labels are kept otherwise). */
  relabel?: boolean;
}

function isCuratedLabel(d: DriftInfo | undefined): d is DriftInfo {
  return d?.labeledBy?.startsWith('human:') === true;
}

/**
 * Deterministic labels plus model judgment for chains with claims from two or
 * more occasions (a chain from one episode has nothing to compare). When a
 * model call fails, that chain keeps its deterministic labels and onWarning
 * hears why. With personSlug, only that person's claims are in the result.
 *
 * Curated seed labels survive: a seed-only chain is answered from `curated`
 * when given, and a seed claim that already carries a hand-written label
 * ("human:...") keeps it when new claims join its chain, unless `relabel`.
 */
export async function refineDrift(l: Ledger, llm: LLM, opts: RefineDriftOptions = {}): Promise<Map<string, DriftInfo>> {
  const det = detectDrift(l);
  const warn = opts.onWarning ?? ((m: string) => console.warn(m));
  const result = new Map<string, DriftInfo>();
  for (const chain of chains(l)) {
    if (opts.personSlug !== undefined && chain.personSlug !== opts.personSlug) continue;
    let entries = chain.claims.map((c): [string, DriftInfo] => [c.id, det.get(c.id)!]);
    if (hasTransitions(chain)) {
      try {
        const seedOnly = chain.claims.every((c) => c.origin === 'seed');
        entries = seedOnly && opts.curated && !opts.relabel ? await curatedOr(chain, det, opts.curated, llm) : await refineChain(chain, det, llm);
      } catch (err) {
        warn(`drift: kept deterministic labels for ${chain.personSlug}/${chain.topic}: ${(err as Error).message}`);
      }
      if (!opts.relabel) {
        const byId = new Map(chain.claims.map((c) => [c.id, c]));
        entries = entries.map(([id, info]) => {
          const kept = byId.get(id)?.drift;
          return [id, byId.get(id)?.origin === 'seed' && isCuratedLabel(kept) ? kept : info];
        });
      }
    }
    for (const [id, info] of entries) result.set(id, info);
  }
  return result;
}

// The curated labels for a seed chain; the live model only when none were recorded.
async function curatedOr(chain: DriftChain, det: Map<string, DriftInfo>, curated: LLM, llm: LLM): Promise<[string, DriftInfo][]> {
  try {
    return await refineChain(chain, det, curated);
  } catch (err) {
    if (curated === llm) throw err;
    return refineChain(chain, det, llm);
  }
}

/**
 * `m` with the curated labels of seed claims put back: what `refineDrift`
 * does for model runs, for the code-only path (no model, or --no-llm).
 */
export function keepCuratedLabels(l: Ledger, m: Map<string, DriftInfo>): Map<string, DriftInfo> {
  const out = new Map(m);
  for (const c of l.claims) {
    if (c.origin === 'seed' && out.has(c.id) && isCuratedLabel(c.drift)) out.set(c.id, c.drift);
  }
  return out;
}

/** New ledger with claim.drift set from `m`; claims not in `m` are unchanged. */
export function applyDrift(l: Ledger, m: Map<string, DriftInfo>): Ledger {
  return {
    ...l,
    claims: l.claims.map((c) => {
      const drift = m.get(c.id);
      return drift ? { ...c, drift } : c;
    }),
  };
}
