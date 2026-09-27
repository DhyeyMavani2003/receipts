// Checks a seed file (data/seed/predictions.json by default) against the
// Claim model and the seed rules: stable ids, real calendar
// dates, hedge probabilities in 0.05 steps, verdicts that agree with their
// grading, evidence links for every graded claim, neutral wording.
//
//   bun scripts/validate-seed.ts [path] [--today YYYY-MM-DD]
//
// Errors make the file unusable (exit 1). Warnings are hand-made choices
// worth a second look, e.g. a probability that differs from the hedge table.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { utcToday } from '../src/config.ts';
import { isCalendarDate } from '../src/extract.ts';
import { latenessMonths } from '../src/grade.ts';
import { claimProbability } from '../src/hedge.ts';
import { claimId, slugify } from '../src/ledger.ts';
import { LOADED_WORDS } from '../src/neutral.ts';
import { CLAIM_TYPES, SOURCE_KINDS, VERDICTS } from '../src/types.ts';
import type { Claim, FinalVerdict } from '../src/types.ts';

export interface SeedReport {
  claims: number;
  people: number;
  graded: number;
  errors: string[];
  warnings: string[];
}

const TOPIC_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_RE = /^[0-9a-f]{12}$/;
const EVIDENCE_REQUIRED = new Set<string>(['correct', 'incorrect', 'partial', 'unresolvable']);
const LATENESS_TOLERANCE_MONTHS = 1;
// A reporter's sentence ("…, Amodei told us") is a paraphrase, not the speaker's words.
const REPORTED_SPEECH = /(?:\b(?:told|tells) (?:us|me|reporters|[A-Z][\w.]*)|\b(?:he|she|they|[A-Z][a-z]+) (?:said|says))[.,]?["”]?\s*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** On the 0.05 grid and inside [0.05, 0.95]. */
export function isProbabilityStep(p: unknown): p is number {
  return typeof p === 'number' && p >= 0.05 - 1e-9 && p <= 0.95 + 1e-9 && Math.abs(p * 20 - Math.round(p * 20)) < 1e-9;
}

function label(c: Record<string, unknown>, i: number): string {
  const who = typeof c.personSlug === 'string' ? c.personSlug : '?';
  const when = typeof c.saidDate === 'string' ? c.saidDate : '?';
  return `#${i + 1} ${who} ${when}`;
}

/** Problems with one claim: [errors, warnings]. */
export function checkClaim(raw: unknown, i: number, today: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { errors: [`#${i + 1}: not an object`], warnings };
  const c = raw;
  const at = label(c, i);
  const err = (m: string) => errors.push(`${at}: ${m}`);
  const warn = (m: string) => warnings.push(`${at}: ${m}`);

  for (const key of ['id', 'person', 'personSlug', 'quote', 'claim', 'topic', 'resolutionCriteria'] as const) {
    if (!nonEmpty(c[key])) err(`${key} is missing or empty`);
  }
  if (typeof c.hedge !== 'string') err('hedge must be a string ("" when there is none)');
  if (typeof c.quoteVerified !== 'boolean') err('quoteVerified must be true or false');
  if (typeof c.quote === 'string') checkQuoteVoice(c.quote, typeof c.person === 'string' ? c.person : '', err, warn);
  if (!isCalendarDate(c.saidDate as string)) err(`saidDate "${String(c.saidDate)}" is not a YYYY-MM-DD date`);
  else if ((c.saidDate as string) > today) err(`saidDate ${c.saidDate} is after today (${today})`);

  if (nonEmpty(c.person) && c.personSlug !== slugify(c.person)) err(`personSlug should be "${slugify(c.person)}"`);
  if (nonEmpty(c.personSlug) && isCalendarDate(c.saidDate as string) && nonEmpty(c.claim)) {
    const id = claimId(c.personSlug, c.saidDate as string, c.claim);
    if (!ID_RE.test(String(c.id))) err(`id "${String(c.id)}" is not 12 hex characters (expected ${id})`);
    else if (c.id !== id) err(`id ${c.id} does not match claimId() = ${id}`);
  }
  if (!(CLAIM_TYPES as readonly unknown[]).includes(c.type)) err(`type "${String(c.type)}" is not one of ${CLAIM_TYPES.join(', ')}`);
  if (nonEmpty(c.topic) && !TOPIC_RE.test(c.topic)) err(`topic "${c.topic}" is not kebab-case`);
  if (c.origin !== 'seed') err(`origin must be "seed" (got "${String(c.origin)}")`);

  const target = c.targetDate;
  if (target !== undefined) {
    if (!isCalendarDate(target as string)) err(`targetDate "${String(target)}" is not a YYYY-MM-DD date`);
    else if (isCalendarDate(c.saidDate as string) && (target as string) < (c.saidDate as string)) err(`targetDate ${target} is before saidDate`);
    if (typeof c.targetDateInferred !== 'boolean') err('targetDateInferred must be true or false when targetDate is set');
    if (c.type !== 'prediction') warn(`a ${String(c.type)} usually has no targetDate`);
  } else if (c.type === 'prediction') {
    err('a prediction needs a targetDate');
  }

  if (!isProbabilityStep(c.impliedProbability)) err(`impliedProbability ${String(c.impliedProbability)} is not a 0.05 step in [0.05, 0.95]`);
  else if (typeof c.hedge === 'string') {
    // Like extraction: only the hedge words the speaker used count, never the claim's wording.
    const table = claimProbability(c.hedge, typeof c.claim === 'string' ? c.claim : '');
    if (Math.abs(table - c.impliedProbability) > 1e-9) warn(`impliedProbability ${c.impliedProbability} differs from the hedge table (${table} for "${c.hedge}")`);
  }
  if (!Number.isInteger(c.specificity) || (c.specificity as number) < 1 || (c.specificity as number) > 5) err('specificity must be an integer 1-5');

  checkSource(c, err);
  checkVerdict(c, today, err, warn);
  for (const key of ['claim', 'resolutionCriteria'] as const) {
    if (typeof c[key] === 'string' && LOADED_WORDS.test(c[key])) err(`${key} uses loaded wording ("${LOADED_WORDS.exec(c[key])![0]}"); describe outcomes, not motives`);
  }
  return { errors, warnings };
}

/** The quote must be the speaker's own words: no reporter's attribution, and a third-person name is worth a look. */
export function checkQuoteVoice(quote: string, person: string, err: (m: string) => void, warn: (m: string) => void): void {
  if (REPORTED_SPEECH.test(quote.trim())) err('quote ends in a reporter\'s attribution ("… told us" / "… said"): quote the speaker\'s own words');
  const last = person.trim().split(/\s+/).at(-1);
  if (last && last.length > 2 && new RegExp(`\\b${last}\\b`).test(quote)) {
    warn(`quote names ${last} in the third person: check it is not a reporter's paraphrase`);
  }
}

function checkSource(c: Record<string, unknown>, err: (m: string) => void): void {
  const s = c.source;
  if (!isRecord(s)) return void err('source is missing');
  if (!nonEmpty(s.title)) err('source.title is missing');
  if (!isHttpUrl(s.url)) err(`source.url "${String(s.url)}" is not an http(s) URL`);
  if (s.date !== c.saidDate) err(`source.date ${String(s.date)} differs from saidDate ${String(c.saidDate)}`);
  if (!(SOURCE_KINDS as readonly unknown[]).includes(s.kind)) err(`source.kind "${String(s.kind)}" is not one of ${SOURCE_KINDS.join(', ')}`);
  if (s.deepLink !== undefined && !isHttpUrl(s.deepLink)) err('source.deepLink is not an http(s) URL');
}

function checkVerdict(c: Record<string, unknown>, today: string, err: (m: string) => void, warn: (m: string) => void): void {
  const verdict = c.verdict;
  if (!(VERDICTS as readonly unknown[]).includes(verdict)) return void err(`verdict "${String(verdict)}" is not one of ${VERDICTS.join(', ')}`);
  const g = c.grading;
  if (verdict === 'pending') {
    if (g !== undefined) err('a pending claim must not carry a grading');
    if (typeof c.targetDate === 'string' && c.targetDate <= today) warn(`deadline ${c.targetDate} has passed: grade it`);
    return;
  }
  if (!isRecord(g)) return void err(`verdict is ${String(verdict)} but there is no grading`);
  if (g.verdict !== verdict) err(`grading.verdict ${String(g.verdict)} differs from verdict ${String(verdict)}`);
  if (g.gradedBy !== 'human:seed') err(`grading.gradedBy must be "human:seed" (got "${String(g.gradedBy)}")`);
  if (typeof g.confidence !== 'number' || g.confidence < 0 || g.confidence > 1) err('grading.confidence must be a number from 0 to 1');
  if (!nonEmpty(g.rationale)) err('grading.rationale is missing');
  else if (LOADED_WORDS.test(g.rationale)) err(`grading.rationale uses loaded wording ("${LOADED_WORDS.exec(g.rationale)![0]}"); describe outcomes, not motives`);
  if (typeof g.gradedAt !== 'string' || Number.isNaN(Date.parse(g.gradedAt))) err('grading.gradedAt is not an ISO timestamp');

  const evidence = Array.isArray(g.evidence) ? g.evidence : null;
  if (!evidence) err('grading.evidence must be a list');
  else {
    if (EVIDENCE_REQUIRED.has(verdict as string) && evidence.length === 0) err(`a ${String(verdict)} verdict needs at least one evidence URL`);
    evidence.forEach((e, k) => {
      if (!isRecord(e) || !isHttpUrl(e.url)) return void err(`evidence[${k}].url is not an http(s) URL`);
      if (e.date !== undefined && !isCalendarDate(e.date as string)) err(`evidence[${k}].date "${String(e.date)}" is not a YYYY-MM-DD date`);
      if (isRecord(c.source) && e.url === c.source.url) warn(`evidence[${k}] is the claim's own source, which is not evidence of the outcome`);
    });
  }

  const resolvedOn = g.resolvedOn;
  if (resolvedOn !== undefined) {
    if (!isCalendarDate(resolvedOn as string)) err(`grading.resolvedOn "${String(resolvedOn)}" is not a YYYY-MM-DD date`);
    else if ((resolvedOn as string) > today) err(`grading.resolvedOn ${resolvedOn} is after today (${today})`);
  }
  const target = typeof c.targetDate === 'string' ? c.targetDate : undefined;
  if (c.type === 'prediction' && target && target > today) {
    if (verdict === 'correct' && resolvedOn === undefined) err(`graded correct before the deadline (${target}) without resolvedOn`);
    if ((verdict === 'incorrect' || verdict === 'partial') && resolvedOn === undefined) warn(`graded ${verdict} before the deadline (${target})`);
  }
  if (verdict === 'too_early' && target && target <= today) warn(`too_early, but the deadline ${target} has passed: grade it`);
  checkLateness(c, g, target, warn);
}

// Seed rows state lateness by hand; flag ones that disagree with grade.ts.
function checkLateness(c: Record<string, unknown>, g: Record<string, unknown>, target: string | undefined, warn: (m: string) => void): void {
  const resolvedOn = isCalendarDate(g.resolvedOn as string) ? (g.resolvedOn as string) : undefined;
  const expected = latenessMonths(c.verdict as FinalVerdict, target, resolvedOn);
  const actual = g.latenessMonths;
  if (actual === undefined) return;
  if (expected === undefined) {
    if (actual !== null) warn(`latenessMonths ${String(actual)} is set, but there is no deadline or resolvedOn to measure it from`);
    return;
  }
  if (expected === null || actual === null) {
    if (expected !== actual) warn(`latenessMonths is ${String(actual)}; grade.ts would record ${String(expected)}`);
    return;
  }
  if (typeof actual !== 'number' || Math.abs(actual - expected) > LATENESS_TOLERANCE_MONTHS) {
    warn(`latenessMonths is ${String(actual)}; grade.ts would record ${expected}`);
  }
}

/** Validate a parsed seed file. */
export function validateSeed(data: unknown, today: string = utcToday()): SeedReport {
  const report: SeedReport = { claims: 0, people: 0, graded: 0, errors: [], warnings: [] };
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.claims)) {
    report.errors.push('the file must look like { "version": 1, "claims": [...] }');
    return report;
  }
  const claims = data.claims as unknown[];
  report.claims = claims.length;
  const seen = new Map<string, number>();
  claims.forEach((raw, i) => {
    const { errors, warnings } = checkClaim(raw, i, today);
    report.errors.push(...errors);
    report.warnings.push(...warnings);
    const id = isRecord(raw) ? raw.id : undefined;
    if (typeof id === 'string' && id) {
      const first = seen.get(id);
      if (first !== undefined) report.errors.push(`#${i + 1}: duplicate id ${id} (same as #${first + 1})`);
      else seen.set(id, i);
    }
  });
  const typed = claims.filter(isRecord) as unknown as Claim[];
  report.people = new Set(typed.map((c) => c.personSlug)).size;
  report.graded = typed.filter((c) => c.grading).length;
  return report;
}

export function formatReport(r: SeedReport, path: string): string {
  const lines = [
    `${path}: ${r.claims} claims, ${r.people} people, ${r.graded} graded; ${r.errors.length} errors, ${r.warnings.length} warnings`,
    ...r.errors.map((e) => `  error   ${e}`),
    ...r.warnings.map((w) => `  warning ${w}`),
  ];
  return lines.join('\n');
}

export const DEFAULT_SEED_PATH = join(import.meta.dir, '..', 'data', 'seed', 'predictions.json');

function cliArgs(args: readonly string[]): { path: string; today: string } {
  let path = DEFAULT_SEED_PATH;
  let today = process.env.RECEIPTS_TODAY || utcToday();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--today') today = args[++i] ?? today;
    else path = args[i]!;
  }
  if (!isCalendarDate(today)) throw new Error(`--today must be YYYY-MM-DD (got "${today}")`);
  return { path, today };
}

if (import.meta.main) {
  const { path, today } = cliArgs(Bun.argv.slice(2));
  const report = validateSeed(JSON.parse(readFileSync(path, 'utf8')), today);
  console.log(formatReport(report, path));
  process.exitCode = report.errors.length ? 1 : 0;
}
