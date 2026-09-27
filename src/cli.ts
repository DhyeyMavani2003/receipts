#!/usr/bin/env bun
// `receipts <command>`: the terminal front end. Each command loads the
// ledger, calls the engine modules, saves, and prints. GBrain is optional
// everywhere (missing -> warn and continue, except `sync`), and the OpenAI
// key is never printed: doctor only says whether it is set.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import { ask } from './ask.ts';
import { findRoot, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { applyDrift, chains, detectDrift, keepCuratedLabels, refineDrift } from './drift.ts';
import { exportRiverSFT } from './export.ts';
import { extractClaims, isCalendarDate, topicsForSpeaker } from './extract.ts';
import type { ProgressEvent } from './extract.ts';
import { GBrain, GBrainMissingError, forgetBrainLinks } from './gbrain.ts';
import { gradeDue } from './grade.ts';
import { claimsFor, dueClaims, loadLedger, patchClaims, saveLedger, slugify, updateLedger, upsertClaims } from './ledger.ts';
import { getLLM } from './llm/index.ts';
import { listModels, pickModel, redactSecrets } from './llm/openai.ts';
import { LLMUnavailableError } from './llm/provider.ts';
import { ReplayLLM, ReplayMissError } from './llm/replay.ts';
import type { LLM } from './llm/provider.ts';
import { scoreAll, scorePerson } from './score.ts';
import { DISCOVER_DEFAULT_LIMIT, DISCOVER_MAX_LIMIT, discoverAppearances, humanDate, pullCandidate, sourceKey } from './discover.ts';
import type { DiscoverResult } from './discover.ts';
import { EXAMPLE_QUESTION, appMode, defaultDeps, runIngest as runIngestPipeline, sourceFor, sourceLinkProblem, startServer } from './server.ts';
import type { IngestEvent, IngestRequest } from './server.ts';
import { writeSite } from './site/render.ts';
import { DRIFT_LABEL_TEXT, NOTABLE_DRIFT, VERDICT_LABEL, fmtBrier, fmtMultiplier, fmtPct, plural } from './site/theme.ts';
import { loadTranscript } from './transcript/load.ts';
import { SOURCE_KINDS } from './types.ts';
import type { Claim, DiscoveredCandidate, DriftInfo, Ledger, PersonScore, SourceKind, Verdict, WatchPerson } from './types.ts';
import { discoveriesPath, follow, loadWatchlist, markChecked, recordDiscovery, unfollow, watchlistPath } from './watchlist.ts';

// ---- Errors ---------------------------------------------------------------------

/** Bad command line: printed with a pointer to --help. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly command?: string,
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

// ---- Argument parsing -------------------------------------------------------------

/** 'optional': a value that may be left out (`--river` alone means the default path). */
export type FlagKind = 'boolean' | 'string' | 'optional';
export type FlagSpec = Readonly<Record<string, FlagKind>>;

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Tiny parser: `--flag`, `--flag value`, `--flag=value`, `-h`, and `--` to end
 * options. Unknown flags are errors, so a typo never silently does nothing.
 */
export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const kind = spec[name];
    if (!kind) throw new UsageError(`Unknown option --${name}.`);
    if (kind === 'boolean') {
      if (eq >= 0) throw new UsageError(`--${name} takes no value.`);
      flags[name] = true;
      continue;
    }
    if (kind === 'optional' && eq < 0 && (argv[i + 1] === undefined || argv[i + 1]!.startsWith('--'))) {
      flags[name] = true;
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || (eq < 0 && value.startsWith('--'))) throw new UsageError(`--${name} needs a value.`);
    flags[name] = value;
  }
  return { positionals, flags };
}

function str(a: ParsedArgs, name: string): string | undefined {
  const v = a.flags[name];
  return typeof v === 'string' ? v : undefined;
}

function bool(a: ParsedArgs, name: string): boolean {
  return a.flags[name] === true;
}

function dateFlag(a: ParsedArgs, name: string): string | undefined {
  const v = str(a, name);
  if (v !== undefined && !isCalendarDate(v)) throw new UsageError(`--${name} must be a date like 2024-03-15 (got "${v}").`);
  return v;
}

function intFlag(a: ParsedArgs, name: string, min: number, max: number): number | undefined {
  const v = str(a, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max} (got "${v}").`);
  return n;
}

function kindFlag(a: ParsedArgs): SourceKind | undefined {
  const v = str(a, 'kind');
  if (v !== undefined && !(SOURCE_KINDS as readonly string[]).includes(v)) {
    throw new UsageError(`--kind must be one of ${SOURCE_KINDS.join(', ')} (got "${v}").`);
  }
  return v as SourceKind | undefined;
}

function urlFlag(a: ParsedArgs, name: string): string | undefined {
  const v = str(a, name);
  if (v !== undefined && !/^https?:\/\//i.test(v)) throw new UsageError(`--${name} must start with http:// or https:// (got "${v}").`);
  return v;
}

// ---- .env -------------------------------------------------------------------------

/** KEY=VALUE lines; `#` comments, `export ` prefixes and surrounding quotes are handled. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, '').trim();
    out[m[1]!] = value;
  }
  return out;
}

/**
 * Bun only loads .env from the working directory, so `receipts` run from
 * elsewhere (via `bun link`) would miss the repo's .env. Fill in variables
 * that are not set at all; anything already in the environment wins, even
 * when empty. Returns the names it set, never the values.
 */
export function loadRootEnv(root: string, env: Record<string, string | undefined> = process.env): string[] {
  const path = join(root, '.env');
  if (!existsSync(path)) return [];
  const set: string[] = [];
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(path, 'utf8')))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    set.push(key);
  }
  return set;
}

// ---- Terminal output ------------------------------------------------------------------

let useColor = false;

function paint(code: string): (s: string) => string {
  return (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
}

const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const blue = paint('34');
const gray = paint('90');

const VERDICT_COLOR: Record<Verdict, (s: string) => string> = {
  correct: green,
  incorrect: red,
  partial: yellow,
  unresolvable: gray,
  too_early: blue,
  pending: blue,
};

export function colorEnabled(env: Record<string, string | undefined>, isTTY: boolean, noColorFlag: boolean): boolean {
  if (noColorFlag || env.NO_COLOR !== undefined) return false;
  return isTTY || (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0');
}

interface Out {
  log(line?: string): void;
  warn(line: string): void;
}

const out: Out = {
  log: (line = '') => console.log(line),
  warn: (line) => console.error(`${yellow('warning:')} ${line}`),
};

function heading(text: string): void {
  out.log(bold(text));
}

function shorten(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function verdictTag(v: Verdict): string {
  return VERDICT_COLOR[v](VERDICT_LABEL[v].toUpperCase().padEnd(12));
}

/** A claim as a few terminal lines: verdict, dates, probability, quote, claim, link. */
export function receiptLines(c: Claim, opts: { rationale?: boolean } = {}): string[] {
  const meta = [
    c.saidDate,
    c.targetDate ? `due ${c.targetDate}` : c.type,
    // A probability only means something for a prediction.
    c.type === 'prediction' ? `${c.hedge ? `"${shorten(c.hedge, 30)}" ` : ''}p=${c.impliedProbability.toFixed(2)}` : '',
    c.topic,
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [`${verdictTag(c.verdict)} ${meta}`, `    “${shorten(c.quote, 220)}”`, `    ${c.claim}`];
  if (c.drift && NOTABLE_DRIFT.has(c.drift.label)) lines.push(`    ${yellow(`${DRIFT_LABEL_TEXT[c.drift.label]}:`)} ${c.drift.note}`);
  if (opts.rationale && c.grading?.rationale) lines.push(`    ${dim(shorten(c.grading.rationale, 300))}`);
  if (opts.rationale && c.grading?.evidence[0]) lines.push(`    ${dim(`evidence: ${c.grading.evidence[0].url}`)}`);
  lines.push(`    ${dim(c.source.deepLink ?? c.source.url)}`);
  return lines;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

/** Leaderboard rows: person, predictions, correct/incorrect/partial, accuracy, Brier, lateness, open, drift. */
export function leaderboardLines(scores: PersonScore[]): string[] {
  const header = `${pad('Person', 20)} ${padLeft('Preds', 5)}  ${pad('C/I/P', 8)} ${padLeft('Acc', 5)} ${padLeft('Brier', 6)} ${padLeft('Late', 6)} ${padLeft('Open', 5)} ${padLeft('Drift', 5)}`;
  const rows = scores.map((s) => {
    const cip = `${s.correct}/${s.incorrect}/${s.partial}`;
    return [
      pad(s.person, 20),
      padLeft(String(s.predictions), 5),
      ` ${pad(cip, 8)}`,
      padLeft(fmtPct(s.accuracy), 5),
      padLeft(fmtBrier(s.brier), 6),
      padLeft(fmtMultiplier(s.latenessMultiplier), 6),
      padLeft(String(s.pending + s.tooEarly), 5),
      padLeft(String(s.driftEvents), 5),
    ].join(' ');
  });
  return [dim(header), ...rows];
}

export function personScoreLines(s: PersonScore): string[] {
  const graded = s.correct + s.incorrect;
  const lines = [
    `${bold(s.person)} (${s.personSlug}): ${plural(s.claims, 'claim')}, ${plural(s.predictions, 'prediction')}`,
    `  Accuracy ${fmtPct(s.accuracy)} (${s.correct} of ${graded})   Brier ${fmtBrier(s.brier)} (coin flip 0.25)   Lateness ${fmtMultiplier(s.latenessMultiplier)}   Drift events ${s.driftEvents}`,
    `  ${green(`${s.correct} correct`)} · ${red(`${s.incorrect} incorrect`)} · ${yellow(`${s.partial} partial`)} · ${gray(`${s.unresolvable} unresolvable`)} · ${blue(`${s.pending + s.tooEarly} open`)}`,
  ];
  if (s.byTopic.length) {
    const width = Math.min(34, Math.max(...s.byTopic.map((t) => t.topic.length)));
    lines.push('  By topic (predictions, correct/incorrect/partial, accuracy):');
    for (const t of s.byTopic) {
      lines.push(`    ${pad(t.topic, width)} ${padLeft(String(t.predictions), 3)}  ${pad(`${t.correct}/${t.incorrect}/${t.partial}`, 8)} ${padLeft(fmtPct(t.accuracy), 4)}`);
    }
  }
  if (s.calibration.length) {
    lines.push('  Calibration (stated vs happened):');
    for (const b of s.calibration) lines.push(`    ${pad(b.bucket, 8)} n=${b.n}  said ${fmtPct(b.predicted)}  happened ${fmtPct(b.observed)}`);
  }
  return lines;
}

// ---- Shared plumbing ---------------------------------------------------------------------

interface Ctx {
  cfg: Config;
}

/** The model client, or a friendly error that says how to fix it. */
function openLLM(cfg: Config): LLM {
  try {
    return getLLM(cfg);
  } catch (err) {
    if (err instanceof LLMUnavailableError) throw err;
    throw new Error(`Could not set up the model client: ${(err as Error).message}`);
  }
}

function tryLLM(cfg: Config): { llm: LLM | null; reason?: string } {
  try {
    return { llm: getLLM(cfg) };
  } catch (err) {
    return { llm: null, reason: (err as Error).message };
  }
}

function newGBrain(cfg: Config): GBrain {
  return new GBrain({ bin: cfg.gbrainBin, home: cfg.gbrainHome, log: (line) => out.log(dim(`  ${line}`)) });
}

/** GBrain when wanted and installed; otherwise null with a note saying why. */
async function openGBrain(cfg: Config, skip: boolean): Promise<GBrain | null> {
  if (skip) {
    out.log(dim('GBrain: skipped (--no-gbrain).'));
    return null;
  }
  const gb = newGBrain(cfg);
  if (await gb.available()) return gb;
  out.warn(`GBrain CLI not found ("${cfg.gbrainBin}"), so person pages were not updated. Everything is in the ledger; install GBrain and run "receipts sync".`);
  return null;
}

/**
 * Push the ledger into GBrain and save. `refresh` names people whose
 * track-record block must be rewritten even when no take changed (drift
 * moved). Returns false on failure, which is reported but not thrown: the
 * ledger keeps whatever rows did land.
 */
async function pushToGBrain(cfg: Config, gb: GBrain, l: Ledger, opts: { personSlug?: string; all?: boolean; refresh?: Iterable<string> } = {}): Promise<boolean> {
  heading(`Syncing to GBrain${opts.personSlug ? ` (people/${opts.personSlug})` : ''}`);
  const progress = (m: string) => out.log(dim(`  ${m}`));
  // syncClaims records rows on `l`'s claims as it goes; merge them into the file even when a later step fails.
  const keepRows = () => updateLedger(cfg.ledgerPath, (fresh) => patchClaims(fresh, l.claims, ['gbrain']));
  // The ledger remembers what it synced. A fresh brain (a new GBRAIN_HOME) has
  // none of those pages, and a plain sync would skip them all.
  const synced = l.claims.find((c) => c.gbrain?.row !== undefined && (!opts.personSlug || c.personSlug === opts.personSlug));
  if (synced) {
    const page = await gb.readPage(`people/${synced.personSlug}`).catch(() => undefined);
    if (page === null) {
      out.warn(`This brain has no page for ${synced.person}, though the ledger says it was synced (a new GBRAIN_HOME?). Run "receipts sync --rebuild" to fill it.`);
    }
  }
  try {
    await gb.syncClaims(l, { personSlug: opts.personSlug, onProgress: progress, trackRecord: opts.all ? 'all' : 'touched', refresh: opts.refresh });
    keepRows();
    out.log(green('  GBrain is up to date.'));
    return true;
  } catch (err) {
    keepRows();
    out.warn(`GBrain sync failed: ${plainError(err)}\n${SYNC_RETRY_NOTE}`);
    return false;
  }
}

/** After a failed sync: everything that landed is kept, and a retry only writes what is missing. */
export const SYNC_RETRY_NOTE =
  'The ledger is saved and everything that did land in GBrain is recorded. Once the cause above is fixed, "receipts sync" writes only what is missing.';

/**
 * A path as the terminal shows it: relative to the working directory when it
 * is inside it, "~/..." inside the home folder, else as is. Keeps the user
 * name off a projected terminal.
 */
export function displayPath(p: string, cwd: string = process.cwd(), home: string = homedir()): string {
  const rel = relative(cwd, p);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel;
  if (home && (p === home || p.startsWith(`${home}${sep}`))) return `~${p.slice(home.length)}`;
  return p;
}

function plainError(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err)).trim() || 'unknown error';
}

function driftKey(d: DriftInfo | undefined): string {
  return d ? `${d.label}|${d.previousClaimId ?? ''}|${d.note}` : '';
}

/** People with at least one claim whose drift label would change. */
function driftChangedPeople(l: Ledger, m: Map<string, DriftInfo>): Set<string> {
  const people = new Set<string>();
  for (const c of l.claims) {
    const next = m.get(c.id);
    if (next && driftKey(next) !== driftKey(c.drift)) people.add(c.personSlug);
  }
  return people;
}

/** "drift: kept deterministic labels for a/b: No replay fixture for drift_labels: <path> is missing. Record…" -> "a/b: no replay fixture". */
export function driftWarningReason(warning: string): string {
  const m = /^drift: kept deterministic labels for (\S+): (.*)$/s.exec(warning);
  if (!m) return shorten(warning, 160);
  const reason = /^No replay fixture/.test(m[2]!) ? 'no replay fixture for this chain (record one with RECEIPTS_RECORD=1)' : shorten(m[2]!, 140);
  return `${m[1]}: ${reason}`;
}

/** The curated drift labels in fixtures/llm, for seed chains in a live run (offline, the model already is the replay). */
function curatedLabels(cfg: Config, llm: LLM): LLM {
  return cfg.llmMode === 'replay' ? llm : new ReplayLLM(cfg.fixturesDir);
}

/**
 * Drift labels for the ledger (optionally one person): the model refines the
 * code labels when one is available; otherwise code labels only. Model
 * failures per chain are summarized, not repeated.
 */
async function computeDrift(cfg: Config, l: Ledger, llm: LLM | null, personSlug?: string, relabel = false): Promise<Map<string, DriftInfo>> {
  if (!llm) {
    const det = relabel ? detectDrift(l) : keepCuratedLabels(l, detectDrift(l));
    if (personSlug === undefined) return det;
    const mine = new Set(claimsFor(l, personSlug).map((c) => c.id));
    return new Map([...det].filter(([id]) => mine.has(id)));
  }
  const warnings: string[] = [];
  const m = await refineDrift(l, llm, { personSlug, onWarning: (w) => warnings.push(w), curated: curatedLabels(cfg, llm), relabel });
  if (warnings.length) out.log(dim(`  ${plural(warnings.length, 'chain')} kept code labels only: ${driftWarningReason(warnings[0]!)}`));
  return m;
}

function printChains(l: Ledger, personSlug?: string): void {
  const people = new Map(l.claims.map((c) => [c.personSlug, c.person]));
  // Two factual claims on one topic do not make a story that can drift.
  const multi = chains(l).filter(
    (ch) => ch.claims.length >= 2 && ch.claims.some((c) => c.type !== 'factual') && (personSlug === undefined || ch.personSlug === personSlug),
  );
  if (!multi.length) {
    out.log(dim('  No topic has two or more claims yet, so there is nothing to compare.'));
    return;
  }
  for (const ch of multi) {
    const deadlines = ch.claims.map((c) => c.targetDate?.slice(0, 4) ?? 'no deadline').join(' → ');
    out.log(`${bold(people.get(ch.personSlug) ?? ch.personSlug)} · ${ch.topic}: ${deadlines}`);
    for (const c of ch.claims) {
      const d = c.drift;
      const label = d ? DRIFT_LABEL_TEXT[d.label] : '';
      const tone = d && NOTABLE_DRIFT.has(d.label) ? yellow : dim;
      out.log(`  ${c.saidDate}  ${pad(c.targetDate ? `due ${c.targetDate}` : 'no deadline', 15)} ${tone(pad(label, 17))} ${dim(shorten(d?.note ?? '', 240))}`);
    }
  }
}

interface SeedFile {
  version: 1;
  claims: Claim[];
}

function readSeedFile(path: string): SeedFile {
  if (!existsSync(path)) throw new Error(`Seed file not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Seed file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const s = parsed as Partial<SeedFile> | null;
  if (!s || s.version !== 1 || !Array.isArray(s.claims)) throw new Error(`Seed file ${path} must look like { "version": 1, "claims": [...] }`);
  for (const [i, c] of s.claims.entries()) {
    if (!c || typeof c.personSlug !== 'string' || !isCalendarDate(c.saidDate) || typeof c.claim !== 'string') {
      throw new Error(`Seed file ${path}: claim #${i + 1} needs personSlug, saidDate (YYYY-MM-DD) and claim. Run "bun scripts/validate-seed.ts".`);
    }
  }
  return { version: 1, claims: s.claims };
}

/** Upsert the seed file into the ledger; returns counts. Does not save. */
function applySeed(l: Ledger, file: string): { added: number; updated: number; people: number; total: number } {
  const seed = readSeedFile(file);
  const { added, updated } = upsertClaims(l, seed.claims.map((c) => ({ ...c, origin: 'seed' as const })));
  return { added: added.length, updated: updated.length, people: new Set(seed.claims.map((c) => c.personSlug)).size, total: seed.claims.length };
}

// ---- Ingest pipeline (ingest and demo --live) ------------------------------------------------

interface IngestFlags {
  dryRun: boolean;
  grade: boolean;
  gbrain: GBrain | null;
}

function printExtractEvent(e: ProgressEvent): void {
  if (e.stage === 'verified' && e.claim) {
    if (e.replacedId) out.log(dim(`  (replaces No. ${e.replacedId} above: the same claim, stated more specifically)`));
    for (const line of receiptLines(e.claim)) out.log(`  ${line}`);
  } else if (e.stage === 'dropped') {
    out.log(`  ${yellow('dropped')} ${dim(shorten(e.message.replace(/^Dropped /, ''), 400))}`);
  } else if (e.stage === 'done') {
    out.log(bold(`  ${e.message}`));
  } else {
    out.log(dim(`  ${e.message}`));
  }
}

/** Load → extract → save → grade → drift → GBrain sync for one episode. Returns the ids of its claims. */
async function ingestEpisode(ctx: Ctx, req: IngestRequest, flags: IngestFlags): Promise<string[]> {
  const { cfg } = ctx;
  const personSlug = slugify(req.speaker);
  if (!personSlug) throw new UsageError('--speaker needs at least one letter or digit.', 'ingest');
  const llm = openLLM(cfg);

  heading(`Loading ${req.input}`);
  const t = await loadTranscript(req.input, { title: req.title, date: req.date, url: req.url, kind: req.kind, openaiKey: cfg.openaiKey });
  const source = sourceFor(t, req, cfg.today);
  if (!req.date && !t.meta.date) out.warn(`No date given or found in the source, so today (${cfg.today}) is used as the date said. Pass --date.`);
  out.log(`  “${source.title}”: ${plural(t.segments.length, 'segment')}, said ${source.date}, ${source.url}`);

  heading(`Extracting claims by ${req.speaker} (${llm.name})`);
  const extracted = await extractClaims(t, llm, {
    speaker: req.speaker,
    speakerSlug: personSlug,
    host: req.host,
    source,
    existingTopics: topicsForSpeaker(loadLedger(cfg.ledgerPath), personSlug, source.url),
    onProgress: printExtractEvent,
  });
  const ids = extracted.claims.map((c) => c.id);
  if (flags.dryRun) {
    out.log(dim(`Dry run: ${plural(ids.length, 'claim')} not written to the ledger or GBrain.`));
    return ids;
  }
  // Every save below reloads the file and merges this run's changes, so a
  // `receipts grade` or `sync` in another terminal meanwhile is not undone.
  let added: Claim[] = [];
  let ledger = updateLedger(cfg.ledgerPath, (l) => {
    added = upsertClaims(l, extracted.claims).added;
  });
  out.log(`Saved ${plural(added.length, 'new claim')} to ${displayPath(cfg.ledgerPath)}.`);
  if (!ids.length) return ids;

  const mineIds = new Set(ids);
  if (flags.grade) ledger = await gradeNew(ctx, ledger, llm, mineIds);

  heading('Drift');
  const topics = new Set(ledger.claims.filter((c) => mineIds.has(c.id)).map((c) => c.topic));
  const touched: Ledger = { ...ledger, claims: claimsFor(ledger, personSlug).filter((c) => topics.has(c.topic)) };
  const labels = await computeDrift(ctx.cfg, touched, llm, personSlug);
  const moved = ids.map((id) => labels.get(id)).filter((d): d is DriftInfo => !!d && NOTABLE_DRIFT.has(d.label));
  const withDrift = updateLedger(cfg.ledgerPath, (l) => applyDrift(l, labels));
  out.log(moved.length ? `  ${yellow('Story drift:')} ${moved.map((d) => d.note).join(' ')}` : dim('  No deadline or goalpost changes against earlier claims on these topics.'));

  if (flags.gbrain) await pushToGBrain(cfg, flags.gbrain, withDrift, { personSlug });
  out.log();
  for (const line of personScoreLines(scorePerson(claimsFor(withDrift, personSlug)))) out.log(line);
  return ids;
}

async function gradeNew(ctx: Ctx, ledger: Ledger, llm: LLM, ids: Set<string>): Promise<Ledger> {
  heading('Grading');
  const mine: Ledger = { ...ledger, claims: ledger.claims.filter((c) => ids.has(c.id)) };
  if (!dueClaims(mine, ctx.cfg.today).length) {
    out.log(dim(`  No new prediction is past its deadline (today is ${ctx.cfg.today}), so nothing to grade yet.`));
    return ledger;
  }
  const progress = gradeProgress(mine, ctx.cfg.llmMode === 'replay');
  const graded = await gradeDue(mine, llm, { today: ctx.cfg.today, onProgress: progress.onEvent });
  progress.summarize();
  return updateLedger(ctx.cfg.ledgerPath, (l) => patchClaims(l, graded, ['verdict', 'grading']));
}

/**
 * Grade progress lines. Judges run concurrently, so each verdict line names
 * its claim. Replay misses (no recorded grading for a claim) are counted and
 * summarized once at the end instead of printed per claim.
 */
function gradeProgress(l: Ledger, replay = false): { onEvent: (e: { claimId: string; message: string; grading?: { verdict: Verdict; confidence: number } }) => void; summarize: () => void } {
  const claimText = new Map(l.claims.map((c) => [c.id, c.claim]));
  let misses = 0;
  return {
    onEvent: (e) => {
      if (e.grading) out.log(`  ${verdictTag(e.grading.verdict)} ${shorten(claimText.get(e.claimId) ?? e.claimId, 120)} ${dim(`(confidence ${e.grading.confidence})`)}`);
      else if (/No replay fixture/.test(e.message)) misses++;
      // Replay answers at once, and each verdict line names its claim.
      else if (replay && e.message.startsWith('Grading: ')) return;
      else out.log(dim(`  ${shorten(e.message, 160)}`));
    },
    summarize: () => {
      if (misses) out.log(dim(`  ${plural(misses, 'prediction')} not graded: no recorded grading for ${misses === 1 ? 'it' : 'them'} (offline replay). Run "receipts grade" live to grade ${misses === 1 ? 'it' : 'them'}.`));
    },
  };
}

// ---- Commands ----------------------------------------------------------------------------

type Status = 'ok' | 'warn' | 'fail';

function check(status: Status, label: string, detail: string): Status {
  const mark = status === 'ok' ? green('ok  ') : status === 'warn' ? yellow('warn') : red('FAIL');
  out.log(`  ${mark}  ${pad(label, 12)} ${detail}`);
  return status;
}

async function commandVersion(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, '--version'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text.trim().split('\n')[0]! : null;
  } catch {
    return null;
  }
}

async function checkModel(cfg: Config): Promise<Status> {
  if (cfg.llmMode === 'replay') {
    const n = existsSync(cfg.fixturesDir) ? readdirSync(cfg.fixturesDir).filter((f) => f.endsWith('.json')).length : 0;
    if (cfg.record) check('warn', 'record', 'RECEIPTS_RECORD is ignored in replay mode');
    return check('ok', 'model', `replay (offline): ${plural(n, 'fixture')} in ${displayPath(cfg.fixturesDir)}; no API calls`);
  }
  if (!cfg.openaiKey) return check('fail', 'model', 'no key, so live extraction and grading cannot run (or use --offline)');
  try {
    const models = await listModels(cfg.openaiKey, { timeoutMs: 15_000 });
    const auto = pickModel(models);
    const extractor = cfg.model ?? auto;
    const grader = cfg.graderModel ?? extractor;
    const missing = [cfg.model, cfg.graderModel].filter((m): m is string => !!m && !models.includes(m));
    const detail = `OpenAI reachable; extractor ${extractor}${cfg.model ? ' (RECEIPTS_MODEL)' : ' (auto)'}, grader ${grader}${cfg.record ? '; recording fixtures' : ''}`;
    if (missing.length) return check('warn', 'model', `${detail}; not in this key's model list: ${missing.join(', ')}`);
    return check('ok', 'model', detail);
  } catch (err) {
    return check('fail', 'model', `OpenAI not usable: ${plainError(err)}`);
  }
}

async function runDoctor(ctx: Ctx): Promise<number> {
  const { cfg } = ctx;
  heading('Receipts doctor');
  const results: Status[] = [];
  results.push(check('ok', 'config', `root ${displayPath(cfg.root)}; today ${cfg.today}; mode ${cfg.llmMode}`));
  const keyStatus: Status = cfg.openaiKey || cfg.llmMode === 'replay' ? 'ok' : 'fail';
  results.push(check(keyStatus, 'OpenAI key', cfg.openaiKey ? 'set' : `missing${cfg.llmMode === 'replay' ? ' (not needed in replay mode)' : ': add OPENAI_API_KEY to .env'}`));
  results.push(await checkModel(cfg));

  const gb = newGBrain(cfg);
  const gbVersion = await gb.version();
  const home = cfg.gbrainHome ? `GBRAIN_HOME ${cfg.gbrainHome}` : 'default brain';
  const brainProblem = gbVersion ? await gb.brainProblem() : null;
  results.push(
    !gbVersion
      ? check('warn', 'gbrain', `not found ("${cfg.gbrainBin}"): bun install -g github:garrytan/gbrain && gbrain init. Receipts still works without it.`)
      : brainProblem
        ? check('fail', 'gbrain', `${gbVersion} (${home}) is installed but the brain did not answer: ${shorten(brainProblem, 200)}`)
        : check('ok', 'gbrain', `${gbVersion} (${home}), brain answers`),
  );
  const yt = await commandVersion('yt-dlp');
  results.push(yt ? check('ok', 'yt-dlp', yt) : check('warn', 'yt-dlp', 'not found; needed only for YouTube URLs: brew install yt-dlp'));

  try {
    if (!existsSync(cfg.ledgerPath)) {
      results.push(check('warn', 'ledger', `${displayPath(cfg.ledgerPath)} does not exist yet: run "receipts seed" or "receipts demo"`));
    } else {
      const l = loadLedger(cfg.ledgerPath);
      const people = new Set(l.claims.map((c) => c.personSlug)).size;
      const graded = l.claims.filter((c) => c.grading).length;
      const due = dueClaims(l, cfg.today).length;
      results.push(check('ok', 'ledger', `${plural(l.claims.length, 'claim')}, ${plural(people, 'person', 'people')}, ${graded} graded, ${due} due for grading (${displayPath(cfg.ledgerPath)})`));
    }
  } catch (err) {
    results.push(check('fail', 'ledger', plainError(err)));
  }
  try {
    results.push(check('ok', 'seed', `${plural(readSeedFile(cfg.seedPath).claims.length, 'curated claim')} in ${displayPath(cfg.seedPath)}`));
  } catch (err) {
    results.push(check('warn', 'seed', plainError(err)));
  }
  const failed = results.filter((s) => s === 'fail').length;
  out.log(failed ? red(`${plural(failed, 'check')} failed.`) : green('Ready.'));
  return failed ? 1 : 0;
}

async function runSeed(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const { cfg } = ctx;
  const file = str(a, 'file') ?? cfg.seedPath;
  const l = loadLedger(cfg.ledgerPath);
  const r = applySeed(l, file);
  saveLedger(cfg.ledgerPath, l);
  out.log(`Seeded ${plural(r.total, 'claim')} for ${plural(r.people, 'person', 'people')}: ${r.added} new, ${r.updated} updated (${displayPath(cfg.ledgerPath)}).`);
  const gb = await openGBrain(cfg, bool(a, 'no-gbrain'));
  if (gb) await pushToGBrain(cfg, gb, l);
  return 0;
}

/** The ingest request from the command line; a local file needs --url so its receipts link a public source. */
function ingestRequestFrom(a: ParsedArgs, input: string, speaker: string, command: string): IngestRequest {
  const req: IngestRequest = { input, speaker };
  const host = str(a, 'host');
  const title = str(a, 'title');
  const date = dateFlag(a, 'date');
  const url = urlFlag(a, 'url');
  const kind = kindFlag(a);
  if (host) req.host = host;
  if (title) req.title = title;
  if (date) req.date = date;
  if (url) req.url = url;
  if (kind) req.kind = kind;
  const linkProblem = sourceLinkProblem(input, url);
  if (linkProblem) throw new UsageError(`${linkProblem} Pass --url.`, command);
  return req;
}

async function runIngest(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const input = a.positionals[0];
  if (!input || a.positionals.length > 1) throw new UsageError('Give exactly one file or URL to ingest.', 'ingest');
  const speaker = str(a, 'speaker');
  if (!speaker) throw new UsageError('--speaker "Full Name" is required: only that person\'s claims are extracted.', 'ingest');
  const req = ingestRequestFrom(a, input, speaker, 'ingest');
  const dryRun = bool(a, 'dry-run');
  const gb = dryRun ? null : await openGBrain(ctx.cfg, bool(a, 'no-gbrain'));
  await ingestEpisode(ctx, req, { dryRun, grade: !bool(a, 'no-grade'), gbrain: gb });
  return 0;
}

async function runGrade(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const { cfg } = ctx;
  const personSlug = str(a, 'person');
  const limit = intFlag(a, 'limit', 1, 10_000);
  const judges = intFlag(a, 'judges', 1, 3) as 1 | 2 | 3 | undefined;
  const regrade = bool(a, 'regrade');
  const l = loadLedger(cfg.ledgerPath);
  // Curated seed verdicts are authoritative: --regrade never replaces them.
  const human = (c: Claim) => c.grading?.gradedBy.startsWith('human:') === true;
  const view: Ledger = regrade ? { ...l, claims: l.claims.filter((c) => !human(c)) } : l;
  const due = dueClaims(view, cfg.today, { personSlug, includeGraded: regrade });
  heading(`Grading ${plural(Math.min(due.length, limit ?? Infinity), 'prediction')} due by ${cfg.today}`);
  if (!due.length) {
    out.log(dim('  Nothing is due. Predictions are graded once their deadline passes.'));
    return 0;
  }
  const llm = openLLM(cfg);
  const progress = gradeProgress(view, cfg.llmMode === 'replay');
  const graded = await gradeDue(view, llm, { today: cfg.today, judges, personSlug, limit, includeGraded: regrade, onProgress: progress.onEvent });
  progress.summarize();
  const saved = updateLedger(cfg.ledgerPath, (fresh) => patchClaims(fresh, graded, ['verdict', 'grading']));
  out.log();
  for (const c of graded) for (const line of receiptLines(c, { rationale: true })) out.log(line);
  const failed = Math.min(due.length, limit ?? Infinity) - graded.length;
  out.log(`${plural(graded.length, 'prediction')} graded${failed ? `, ${failed} not graded (see messages above)` : ''}.`);
  if (graded.length) {
    const gb = await openGBrain(cfg, bool(a, 'no-gbrain'));
    if (gb) await pushToGBrain(cfg, gb, saved);
  }
  return failed && !graded.length ? 1 : 0;
}

async function runDrift(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const { cfg } = ctx;
  const personSlug = str(a, 'person');
  const l = loadLedger(cfg.ledgerPath);
  if (personSlug !== undefined && !claimsFor(l, personSlug).length) throw new Error(`No claims for "${personSlug}" in the ledger.`);
  let llm: LLM | null = null;
  if (!bool(a, 'no-llm')) {
    const r = tryLLM(cfg);
    llm = r.llm;
    if (!llm) out.warn(`No model (${r.reason}); using code-computed labels only.`);
  }
  heading(`Drift${llm ? ` (code labels + ${llm.name} judgment)` : ' (code labels only)'}`);
  const m = await computeDrift(cfg, l, llm, personSlug, bool(a, 'relabel'));
  const changed = driftChangedPeople(l, m);
  const next = updateLedger(cfg.ledgerPath, (fresh) => applyDrift(fresh, m));
  printChains(next, personSlug);
  out.log(dim(`Drift labels ${changed.size ? `changed for ${plural(changed.size, 'person', 'people')}` : 'unchanged'}.`));
  if (changed.size) {
    const gb = await openGBrain(cfg, bool(a, 'no-gbrain'));
    if (gb) await pushToGBrain(cfg, gb, next, { personSlug, refresh: changed });
  }
  return 0;
}

async function runScore(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const l = loadLedger(ctx.cfg.ledgerPath);
  const personSlug = str(a, 'person');
  if (personSlug !== undefined) {
    const claims = claimsFor(l, personSlug);
    if (!claims.length) throw new Error(`No claims for "${personSlug}" in the ledger.`);
    const s = scorePerson(claims);
    if (bool(a, 'vs-gbrain')) return printParity(ctx.cfg, s);
    if (bool(a, 'json')) out.log(JSON.stringify(s, null, 2));
    else for (const line of personScoreLines(s)) out.log(line);
    return 0;
  }
  if (bool(a, 'vs-gbrain')) throw new UsageError('--vs-gbrain compares one person: add --person slug.', 'score');
  const scores = scoreAll(l);
  if (bool(a, 'json')) {
    out.log(JSON.stringify(scores, null, 2));
    return 0;
  }
  if (!scores.length) {
    out.log('The ledger is empty: run "receipts seed" or "receipts ingest" first.');
    return 0;
  }
  heading(`Track records (${plural(l.claims.length, 'claim')}, as of ${ctx.cfg.today})`);
  for (const line of leaderboardLines(scores)) out.log(line);
  out.log(dim('Accuracy = correct / (correct + incorrect). Brier: 0.25 is a coin flip, lower is better. Late = how many times longer than promised late-but-true predictions took.'));
  return 0;
}

function fixed3(x: unknown): string {
  return typeof x === 'number' ? x.toFixed(3) : 'n/a';
}

/** "accuracy 0.250 · Brier 0.435 · 12 bets" for Receipts' or GBrain's numbers. */
export function parityLine(accuracy: unknown, brier: unknown, bets: unknown): string {
  return `accuracy ${fixed3(accuracy)} · Brier ${fixed3(brier)} · ${typeof bets === 'number' ? plural(bets, 'bet') : 'n/a bets'}`;
}

/** One line each for Receipts and GBrain's own `takes scorecard`, to 3 decimals, so "same numbers" reads at a glance. */
async function printParity(cfg: Config, s: PersonScore): Promise<number> {
  const gb = newGBrain(cfg);
  if (!(await gb.available())) throw new GBrainMissingError(cfg.gbrainBin);
  const card = (await gb.scorecard(s.personSlug)) ?? {};
  const mine = parityLine(s.accuracy, s.brier, s.predictions);
  const theirs = parityLine(card.accuracy, card.brier, card.total_bets);
  out.log(`Receipts ${s.personSlug}: ${mine}`);
  out.log(`GBrain   people/${s.personSlug}: ${theirs}`);
  out.log(mine === theirs ? green('Same numbers.') : yellow('The numbers differ: run "receipts sync" and check for resolution conflicts above.'));
  return mine === theirs ? 0 : 1;
}

async function runSync(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const { cfg } = ctx;
  const personSlug = str(a, 'person');
  const l = loadLedger(cfg.ledgerPath);
  if (personSlug !== undefined && !claimsFor(l, personSlug).length) throw new Error(`No claims for "${personSlug}" in the ledger.`);
  const gb = newGBrain(cfg);
  if (!(await gb.available())) throw new GBrainMissingError(cfg.gbrainBin);
  if (bool(a, 'rebuild')) {
    const dropped = forgetBrainLinks(l, personSlug);
    out.log(dim(`Rebuild: forgot ${plural(dropped, 'GBrain link')}; takes already in the brain are matched, not added twice.`));
    updateLedger(cfg.ledgerPath, (fresh) => {
      forgetBrainLinks(fresh, personSlug);
    });
  }
  return (await pushToGBrain(cfg, gb, l, { personSlug, all: true })) ? 0 : 1;
}

async function runSite(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const outDir = str(a, 'out') ?? join(ctx.cfg.outDir, 'site');
  const written = writeSite(loadLedger(ctx.cfg.ledgerPath), outDir);
  out.log(`Wrote ${plural(written.length, 'page')} to ${displayPath(outDir)}`);
  out.log(dim(`Open ${displayPath(written[0]!)}`));
  return 0;
}

/** Printed by `receipts serve` when it would call OpenAI but has no key. */
export function serveNoKeyWarning(): string {
  return 'Warning: no OPENAI_API_KEY is set, so the ingest form will fail and the ask box falls back to the offline template. Add the key to .env, or restart with "receipts serve --offline" to replay the recorded demo answers.';
}

async function runServe(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const port = intFlag(a, 'port', 0, 65_535) ?? 4321;
  const server = startServer(ctx.cfg, { port });
  const noKey = ctx.cfg.llmMode !== 'replay' && !ctx.cfg.openaiKey;
  const mode = ctx.cfg.llmMode === 'replay' ? 'offline replay' : noKey ? 'live model, but no OPENAI_API_KEY' : 'live model';
  out.log(`${bold('Receipts')} is live at ${server.url}  (${mode}, ledger ${displayPath(ctx.cfg.ledgerPath)})`);
  if (noKey) {
    out.log(yellow(serveNoKeyWarning()));
  }
  out.log(dim('Ctrl-C to stop.'));
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function runAsk(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const question = a.positionals.join(' ').trim();
  if (!question) throw new UsageError(`Ask a question, e.g. receipts ask "${EXAMPLE_QUESTION}"`, 'ask');
  const l = loadLedger(ctx.cfg.ledgerPath);
  // No GBrain scorecards in the prompt: /api/ask sends none either, so a
  // fixture recorded from the CLI replays in the web ask box and vice versa.
  const { llm, reason } = tryLLM(ctx.cfg);
  let note = llm ? undefined : `no model (${reason})`;
  let result;
  try {
    result = await ask(question, l, llm);
  } catch (err) {
    note = `the model failed (${plainError(err)})`;
    result = await ask(question, l, null);
  }
  if (!result.usedModel && llm && !note && !result.note && result.people.length > 0) note = 'no model answer for this question (offline fixtures cover recorded questions only)';
  if (bool(a, 'json')) {
    out.log(JSON.stringify({ ...result, receipts: result.receipts.map((c) => c.id), note: [note, result.note].filter(Boolean).join(' ') || undefined }, null, 2));
    return 0;
  }
  out.log(result.answer);
  if (result.note) out.log(dim(result.note));
  if (result.receipts.length) {
    out.log();
    heading('Receipts');
    for (const c of result.receipts) for (const line of receiptLines(c)) out.log(line);
  }
  if (result.usedModel) out.log(dim(`Answered by the model from ${plural(result.receipts.length, 'receipt')} in the ledger.`));
  else if (note) out.log(dim(`Answered from the ledger with the offline template: ${note}.`));
  else if (result.people.length > 0) out.log(dim('Answered from the ledger with the offline template.'));
  return 0;
}

async function runExport(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const path = str(a, 'river') ?? join(ctx.cfg.outDir, 'river-sft.jsonl');
  const n = exportRiverSFT(loadLedger(ctx.cfg.ledgerPath), path);
  out.log(`Wrote ${plural(n, 'training example')} to ${displayPath(path)} (chat JSONL: system brief, claim + evidence, verdict JSON).`);
  if (!n) out.log(dim('Only graded claims with evidence are exported. Seed or grade first.'));
  return 0;
}

async function runDemo(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const { cfg } = ctx;
  const live = str(a, 'live');
  const speaker = str(a, 'speaker');
  if (live && !speaker) throw new UsageError('--live needs --speaker "Full Name".', 'demo');
  if (speaker && !live) throw new UsageError('--speaker only applies with --live <url or file>.', 'demo');

  heading('1. Seed: curated predictions (sources linked)');
  const l = loadLedger(cfg.ledgerPath);
  const r = applySeed(l, cfg.seedPath);
  saveLedger(cfg.ledgerPath, l);
  out.log(`  ${plural(r.total, 'claim')} for ${plural(r.people, 'person', 'people')}: ${r.added} new, ${r.updated} updated.`);

  const req = live && speaker ? ingestRequestFrom(a, live, speaker, 'demo') : null;
  const gb = await openGBrain(cfg, bool(a, 'no-gbrain'));
  if (req) {
    heading('2. Live episode');
    // Sync happens once below, after drift, so GBrain gets everything in one pass.
    // A failed live episode is reported, and the demo goes on with the seed alone.
    try {
      await ingestEpisode(ctx, req, { dryRun: false, grade: true, gbrain: null });
    } catch (err) {
      out.warn(`The live episode failed: ${plainError(err)}${hintFor(err) ? `\n${hintFor(err)}` : ''}\nContinuing with the seeded ledger.`);
    }
  }

  heading(`${live ? 3 : 2}. Drift`);
  const current = loadLedger(cfg.ledgerPath);
  const { llm, reason } = tryLLM(cfg);
  if (!llm) out.log(dim(`  No model (${reason}); code labels only.`));
  const m = await computeDrift(cfg, current, llm);
  const changed = driftChangedPeople(current, m);
  const withDrift = updateLedger(cfg.ledgerPath, (fresh) => applyDrift(fresh, m));
  printChains(withDrift);

  if (gb) await pushToGBrain(cfg, gb, withDrift, { refresh: changed });
  const final = loadLedger(cfg.ledgerPath);

  heading(`${live ? 4 : 3}. Site`);
  const outDir = str(a, 'out') ?? join(cfg.outDir, 'site');
  const written = writeSite(final, outDir);
  out.log(`  Wrote ${plural(written.length, 'page')} to ${displayPath(outDir)}`);

  out.log();
  heading('Leaderboard');
  for (const line of leaderboardLines(scoreAll(final))) out.log(line);
  out.log();
  out.log(`Next: ${bold(`receipts serve${cfg.llmMode === 'replay' ? ' --offline' : ''}`)} for the live site, ${bold(`receipts ask "${EXAMPLE_QUESTION}"`)}${gb ? `, ${bold('gbrain takes scorecard people/elon-musk --json')}` : ''}.`);
  return 0;
}

// ---- Following and discovery ---------------------------------------------------------

const WATCH_MAX_PEOPLE = 10;
const WATCH_MAX_PULLS = 3;

/** Human line for a pull's progress event; null for events the terminal skips. */
function pullEventLine(e: IngestEvent): string | null {
  if (e.stage === 'verified' && e.claim) return receiptLines(e.claim).map((l) => `  ${l}`).join('\n');
  if (e.stage === 'error') return `  ${red('error:')} ${e.message}`;
  if (e.stage === 'complete') return bold(`  ${e.message}`);
  if (e.stage === 'graded' || e.stage === 'drift' || e.stage === 'saved') return `  ${e.message}`;
  if (e.stage === 'chunk' || e.stage === 'candidates' || e.stage === 'load' || e.stage === 'grade' || e.stage === 'warning' || e.stage === 'sync') return dim(`  ${e.message}`);
  return null;
}

export function candidateLines(i: number, c: DiscoveredCandidate | DiscoverResult['candidates'][number]): string[] {
  const parts = [c.date || 'undated', c.durationMin ? `${c.durationMin} min` : null, c.show || null, c.title].filter(Boolean);
  const status = 'status' in c && c.status !== 'new' ? ` ${dim(`[${c.status === 'have' ? 'already in your receipts' : c.status}${c.receipts !== undefined ? `: ${plural(c.receipts, 'receipt')}` : ''}]`)}` : '';
  const notes = [c.transcriptSource === 'audio' || c.transcriptSource === 'unknown' ? 'no transcript we can read' : null, c.linkConfirmed ? null : 'link not confirmed by search'].filter(Boolean);
  return [`${i}. ${parts.join(' · ')}${status}`, dim(`   ${c.url}`), dim(`   ${c.why}${notes.length ? ` (${notes.join('; ')})` : ''}`)];
}

function replayMissNote(name: string): string {
  return `Live search is off (offline replay), and there is no recording of a search for ${name}. Add OPENAI_API_KEY and run without --offline.`;
}

/** The four-line check `receipts start` prints before serving. */
export function startDoctorLines(cfg: Config, env: Record<string, string | undefined> = process.env): string[] {
  const mode = appMode(cfg);
  const model = mode === 'live' ? 'live (key set)' : mode === 'replay' ? 'offline replay' : 'no API key: recorded answers only';
  const ytdlp = Bun.which(env.YT_DLP_BIN || 'yt-dlp') ? 'yt-dlp found' : 'not found (the built-in fallback is used)';
  const gbrain = Bun.which(cfg.gbrainBin) ? 'found' : 'not found (receipts are saved here only)';
  const l = loadLedger(cfg.ledgerPath);
  const people = new Set(l.claims.map((c) => c.personSlug)).size;
  let following = 0;
  try {
    following = loadWatchlist(watchlistPath(cfg.ledgerPath)).people.length;
  } catch {
    following = 0;
  }
  return [
    `Model: ${model}`,
    `YouTube captions: ${ytdlp}`,
    `GBrain: ${gbrain}`,
    `Ledger: ${plural(l.claims.length, 'receipt')} on ${plural(people, 'person', 'people')} · following ${following}`,
  ];
}

async function runStart(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const cfg = ctx.cfg;
  const port = intFlag(a, 'port', 0, 65_535) ?? 4321;
  for (const line of startDoctorLines(cfg)) out.log(`  ${line}`);
  if (appMode(cfg) === 'live' && process.env.RECEIPTS_RECORD === undefined) {
    cfg.record = true;
    out.log(dim('  Recording model answers to fixtures/llm so the demo can replay offline.'));
  }
  let server: ReturnType<typeof startServer> | undefined;
  let lastErr: unknown;
  for (let p = port; p < port + 10 && !server; p++) {
    try {
      server = startServer(cfg, { port: p });
    } catch (err) {
      lastErr = err;
      if (port === 0) break;
    }
  }
  if (!server) {
    out.warn(`Could not start the server on ports ${port} to ${port + 9}: ${plainError(lastErr)}`);
    return 1;
  }
  if (server.port !== port && port !== 0) out.log(yellow(`Port ${port} is busy, so Receipts is using ${server.port}.`));
  out.log(`${bold('Receipts')} is open at ${server.url}  ${dim('(Ctrl-C to stop)')}`);
  if (!bool(a, 'no-open') && process.stdout.isTTY) {
    try {
      Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', server.url], { stdout: 'ignore', stderr: 'ignore' });
    } catch {
      // no browser opener; the URL is printed above
    }
  }
  await new Promise<void>((resolve) => {
    const stop = () => {
      server!.stop();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

/** Discover for one followed person, store the run, print it. Null when an offline replay has no recording. */
async function discoverFor(cfg: Config, llm: LLM, person: WatchPerson, opts: { limit?: number; since?: string }): Promise<DiscoveredCandidate[] | null> {
  heading(`Recent appearances for ${person.name}`);
  let result: DiscoverResult;
  try {
    result = await discoverAppearances(person.name, llm, {
      today: cfg.today,
      since: opts.since,
      limit: opts.limit,
      ledger: loadLedger(cfg.ledgerPath),
      checkLinks: cfg.llmMode === 'replay' ? undefined : (url, init) => fetch(url, init),
      onProgress: (e) => {
        if (e.stage === 'searching' || e.stage === 'waiting' || e.stage === 'found') out.log(dim(`  ${e.message}`));
      },
    });
  } catch (err) {
    if (err instanceof ReplayMissError) {
      out.warn(replayMissNote(person.name));
      return null;
    }
    throw err;
  }
  const haveKeys = new Set(result.have.map((c) => sourceKey(c.url) ?? c.url));
  const record = recordDiscovery(discoveriesPath(cfg.ledgerPath), person.slug, { since: result.since, candidates: [...result.candidates, ...result.have], have: haveKeys });
  markChecked(watchlistPath(cfg.ledgerPath), person.slug);
  const fresh = new Set(result.candidates.map((c) => sourceKey(c.url) ?? c.url));
  const shown = record.candidates.filter((c) => fresh.has(sourceKey(c.url) ?? c.url));
  shown.forEach((c, i) => {
    for (const line of candidateLines(i + 1, c)) out.log(line);
  });
  if (!shown.length) out.log(`  No new long-form appearances found since ${humanDate(result.since)}.`);
  const notes = [result.have.length ? `${result.have.length} already in your receipts` : null, result.dropped.length ? `${result.dropped.length} left out (${[...new Set(result.dropped.map((d) => d.reason))].join(', ')})` : null].filter(Boolean);
  if (notes.length) out.log(dim(`  ${notes.join('; ')}.`));
  if (result.model.startsWith('replay:')) out.log(dim('  (from a recorded search)'));
  return shown;
}

/** Pull up to `n` candidates still marked new, one at a time. Returns how many finished. */
async function pullNew(cfg: Config, person: WatchPerson, found: DiscoveredCandidate[], n: number, maxMinutes: number | undefined, noGBrain: boolean): Promise<number> {
  const todo = found.filter((c) => c.status === 'new' && (c.transcriptSource === 'youtube' || c.transcriptSource === 'page')).slice(0, n);
  let done = 0;
  for (const c of todo) {
    heading(`Pulling receipts: ${c.title}${maxMinutes ? ` (first ${maxMinutes} min)` : ''}`);
    const base = defaultDeps();
    const deps = { ...base, getLLM: (conf: Config) => openLLM(conf), ...(noGBrain ? { gbrain: () => null } : {}) };
    let ok = false;
    await pullCandidate(c, person, {
      cfg,
      deps,
      run: runIngestPipeline,
      maxMinutes,
      log: (line) => out.log(dim(`  ${line}`)),
      send: (e) => {
        if (e.stage === 'complete') ok = true;
        const line = pullEventLine(e);
        if (line) out.log(line);
      },
    });
    if (ok) done++;
  }
  return done;
}

function nameArg(a: ParsedArgs, command: string): string {
  const name = a.positionals.join(' ').replace(/\s+/g, ' ').trim();
  if (!name) throw new UsageError('Give a name, e.g. "Jensen Huang".', command);
  if (name.length > 120) throw new UsageError('A name can be at most 120 characters.', command);
  return name;
}

async function runFollow(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const name = nameArg(a, 'follow');
  const { person, created } = follow(watchlistPath(ctx.cfg.ledgerPath), name);
  out.log(created ? `Following ${person.name}.` : `Already following ${person.name}.`);
  if (!bool(a, 'discover')) {
    out.log(dim(`Next: receipts discover "${person.name}" to find their recent interviews, podcasts and talks.`));
    return 0;
  }
  await discoverFor(ctx.cfg, openLLM(ctx.cfg), person, {});
  return 0;
}

async function runUnfollow(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const name = nameArg(a, 'unfollow');
  const path = watchlistPath(ctx.cfg.ledgerPath);
  const slug = slugify(name);
  const who = loadWatchlist(path).people.find((p) => p.slug === slug);
  if (!unfollow(path, name)) {
    out.log(`Not following ${name}.`);
    return 1;
  }
  out.log(`No longer following ${who?.name ?? name}.`);
  return 0;
}

function maxMinutesFlag(a: ParsedArgs): number | undefined {
  return intFlag(a, 'max-minutes', 1, 600);
}

async function runDiscover(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const { cfg } = ctx;
  const limit = intFlag(a, 'limit', 1, DISCOVER_MAX_LIMIT) ?? DISCOVER_DEFAULT_LIMIT;
  const since = dateFlag(a, 'since');
  const pulls = intFlag(a, 'pull', 0, DISCOVER_MAX_LIMIT) ?? 0;
  const maxMinutes = maxMinutesFlag(a);
  const wl = watchlistPath(cfg.ledgerPath);
  let people: WatchPerson[];
  if (a.positionals.length) {
    const { person, created } = follow(wl, nameArg(a, 'discover'));
    if (created) out.log(`Following ${person.name}.`);
    people = [person];
  } else {
    people = loadWatchlist(wl).people;
    if (!people.length) throw new UsageError('You are not following anyone yet. Try: receipts follow "Jensen Huang" --discover', 'discover');
  }
  const llm = openLLM(cfg);
  let missed = 0;
  for (const person of people) {
    const found = await discoverFor(cfg, llm, person, { limit, since });
    if (!found) {
      missed++;
      continue;
    }
    if (pulls > 0) await pullNew(cfg, person, found, pulls, maxMinutes, bool(a, 'no-gbrain'));
    out.log();
  }
  return missed === people.length ? 1 : 0;
}

/** "24h", "90m", "2d" -> ms. */
export function parseEvery(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/i.exec(v.trim());
  if (!m) throw new UsageError(`--every must look like 24h, 90m or 2d (got "${v}").`, 'watch');
  const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as 'm' | 'h' | 'd'];
  if (ms < 3_600_000) throw new UsageError('--every must be at least 1h.', 'watch');
  return ms;
}

/** People whose last check is older than `everyMs` (never checked counts as due), oldest first, at most 10. */
export function duePeople(people: readonly WatchPerson[], everyMs: number, now: Date = new Date()): WatchPerson[] {
  const last = (p: WatchPerson) => (p.lastCheckedAt ? Date.parse(p.lastCheckedAt) : 0);
  return people
    .filter((p) => now.getTime() - last(p) >= everyMs)
    .sort((x, y) => last(x) - last(y))
    .slice(0, WATCH_MAX_PEOPLE);
}

async function runWatch(ctx: Ctx, a: ParsedArgs): Promise<number> {
  const { cfg } = ctx;
  const pulls = intFlag(a, 'pull', 0, WATCH_MAX_PULLS) ?? 0;
  const maxMinutes = maxMinutesFlag(a);
  const everyFlag = str(a, 'every');
  const everyMs = everyFlag ? parseEvery(everyFlag) : 24 * 3_600_000;
  const wl = watchlistPath(cfg.ledgerPath);
  if (!loadWatchlist(wl).people.length) throw new UsageError('You are not following anyone yet. Try: receipts follow "Jensen Huang"', 'watch');
  const llm = openLLM(cfg);
  let stop = false;
  const onSigint = () => {
    stop = true;
    out.log(dim('Stopping after the current step...'));
  };
  if (everyFlag) process.on('SIGINT', onSigint);
  try {
    for (;;) {
      const due = duePeople(loadWatchlist(wl).people, everyMs);
      if (!due.length) out.log(dim(`Nobody is due for a check (every ${everyFlag ?? '24h'}).`));
      for (const person of due) {
        if (stop) break;
        const found = await discoverFor(cfg, llm, person, {});
        if (found && pulls > 0) await pullNew(cfg, person, found, pulls, maxMinutes, bool(a, 'no-gbrain'));
        out.log();
      }
      if (!everyFlag || stop) return 0;
      const next = Math.min(...loadWatchlist(wl).people.map((p) => (p.lastCheckedAt ? Date.parse(p.lastCheckedAt) : 0) + everyMs));
      const wait = Math.max(60_000, next - Date.now());
      out.log(dim(`Next check at ${new Date(Date.now() + wait).toLocaleString()}. Ctrl-C stops.`));
      for (let slept = 0; slept < wait && !stop; slept += 1000) await Bun.sleep(1000);
      if (stop) return 0;
    }
  } finally {
    if (everyFlag) process.off('SIGINT', onSigint);
  }
}

// ---- Command table and main ---------------------------------------------------------------------

interface CommandDef {
  usage: string;
  summary: string;
  flags: FlagSpec;
  run(ctx: Ctx, a: ParsedArgs): Promise<number>;
}

const GLOBAL_FLAGS: FlagSpec = { ledger: 'string', offline: 'boolean', today: 'string', help: 'boolean', 'no-color': 'boolean', version: 'boolean' };
const EPISODE_FLAGS: FlagSpec = { speaker: 'string', host: 'string', title: 'string', date: 'string', url: 'string', kind: 'string' };

export const COMMANDS: Record<string, CommandDef> = {
  doctor: {
    usage: 'receipts doctor',
    summary: 'Check the key (set/missing, never printed), model, gbrain, yt-dlp and ledger',
    flags: {},
    run: (ctx) => runDoctor(ctx),
  },
  seed: {
    usage: 'receipts seed [--file data/seed/predictions.json] [--no-gbrain]',
    summary: 'Load the curated seed predictions (sources linked) into the ledger and GBrain',
    flags: { file: 'string', 'no-gbrain': 'boolean' },
    run: runSeed,
  },
  ingest: {
    usage:
      'receipts ingest <file|url> --speaker "Name" [--host "Name"] [--title T] [--date YYYY-MM-DD] [--url U] [--kind podcast] [--dry-run] [--no-gbrain] [--no-grade]',
    summary: 'Extract, quote-check, grade, drift-label and sync one episode',
    flags: { ...EPISODE_FLAGS, 'dry-run': 'boolean', 'no-gbrain': 'boolean', 'no-grade': 'boolean' },
    run: runIngest,
  },
  grade: {
    usage: 'receipts grade [--person slug] [--limit N] [--judges 1|2|3] [--regrade] [--no-gbrain]',
    summary: 'Grade predictions whose deadline has passed (web evidence, 2 judges)',
    flags: { person: 'string', limit: 'string', judges: 'string', regrade: 'boolean', 'no-gbrain': 'boolean' },
    run: runGrade,
  },
  drift: {
    usage: 'receipts drift [--person slug] [--no-llm] [--relabel] [--no-gbrain]',
    summary: "Label how each person's story moved on each topic (curated seed labels are kept unless --relabel)",
    flags: { person: 'string', 'no-llm': 'boolean', relabel: 'boolean', 'no-gbrain': 'boolean' },
    run: runDrift,
  },
  score: {
    usage: 'receipts score [--person slug [--vs-gbrain]] [--json]',
    summary: 'Track records: accuracy, Brier, lateness, drift; --vs-gbrain puts GBrain\'s own scorecard beside them',
    flags: { person: 'string', json: 'boolean', 'vs-gbrain': 'boolean' },
    run: runScore,
  },
  sync: {
    usage: 'receipts sync [--person slug] [--rebuild]',
    summary: 'Push the ledger into GBrain (idempotent); --rebuild writes it into a new or different brain from scratch',
    flags: { person: 'string', rebuild: 'boolean' },
    run: runSync,
  },
  site: {
    usage: 'receipts site [--out out/site]',
    summary: 'Write the static site (index + one page per person)',
    flags: { out: 'string' },
    run: runSite,
  },
  start: {
    usage: 'receipts start [--port 4321] [--no-open] [--offline] [--today YYYY-MM-DD]',
    summary: 'Check the setup, open the one-box dashboard in your browser (live by default, --offline replays recordings)',
    flags: { port: 'string', 'no-open': 'boolean' },
    run: runStart,
  },
  serve: {
    usage: 'receipts serve [--port 4321]',
    summary: 'Live site with the ingest form and the ask box',
    flags: { port: 'string' },
    run: runServe,
  },
  ask: {
    usage: 'receipts ask "question" [--json]',
    summary: '"How much should I trust X on Y?", answered with receipts',
    flags: { json: 'boolean' },
    run: runAsk,
  },
  follow: {
    usage: 'receipts follow "<name>" [--discover]',
    summary: 'Follow a person; --discover then looks for their recent long-form appearances',
    flags: { discover: 'boolean' },
    run: runFollow,
  },
  unfollow: {
    usage: 'receipts unfollow "<name or slug>"',
    summary: 'Stop following a person (their receipts stay)',
    flags: {},
    run: runUnfollow,
  },
  discover: {
    usage: 'receipts discover ["<name>"] [--limit N] [--since YYYY-MM-DD] [--pull N] [--max-minutes M] [--no-gbrain]',
    summary: 'Find recent interviews, podcasts and talks (web search); no name = everyone you follow; --pull N pulls the top N',
    flags: { limit: 'string', since: 'string', pull: 'string', 'max-minutes': 'string', 'no-gbrain': 'boolean' },
    run: runDiscover,
  },
  watch: {
    usage: 'receipts watch [--pull N] [--every 24h] [--max-minutes M] [--no-gbrain]',
    summary: 'Check everyone you follow who is due; --every keeps checking on a schedule until Ctrl-C',
    flags: { pull: 'string', every: 'string', 'max-minutes': 'string', 'no-gbrain': 'boolean' },
    run: runWatch,
  },
  export: {
    usage: 'receipts export [--river [out/river-sft.jsonl]]',
    summary: 'River SFT export of graded claims (chat JSONL)',
    flags: { river: 'optional' },
    run: runExport,
  },
  demo: {
    usage: 'receipts demo [--live <url|file> --speaker "Name" [--host "Name"] [--title T] [--date D] [--url U]] [--out out/site] [--no-gbrain]',
    summary: 'seed → (live episode) → drift → GBrain sync → site → leaderboard',
    flags: { ...EPISODE_FLAGS, live: 'string', out: 'string', 'no-gbrain': 'boolean' },
    run: runDemo,
  },
};

const ALL_FLAGS: FlagSpec = Object.assign({}, GLOBAL_FLAGS, ...Object.values(COMMANDS).map((c) => c.flags));

export function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
  return [
    'Receipts: dated, verbatim-quoted claims from podcasts and interviews, graded when they come due.',
    '',
    'Usage: receipts <command> [options]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${pad(name, width)}  ${c.summary}`),
    '',
    'Global options:',
    '  --ledger <path>   ledger file (default data/ledger.json)',
    '  --offline         answer model calls from fixtures/llm (same as RECEIPTS_LLM=replay)',
    '  --today <date>    treat YYYY-MM-DD as today (same as RECEIPTS_TODAY)',
    '  --no-color        plain output (NO_COLOR works too)',
    '',
    'Run "receipts <command> --help" for a command\'s options.',
  ].join('\n');
}

function packageVersion(root: string): string {
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function hintFor(err: unknown): string | undefined {
  // A replay miss already says which prompt field differs from the recording.
  if (err instanceof ReplayMissError) return 'Offline runs replay recorded answers only. For anything else, drop --offline and add OPENAI_API_KEY to .env.';
  if (err instanceof LLMUnavailableError) return 'Add OPENAI_API_KEY to .env for live runs, or pass --offline to use recorded fixtures.';
  return undefined;
}

/** Run one command line; returns the exit code. Never throws. */
export async function main(argv: readonly string[]): Promise<number> {
  let commandName: string | undefined;
  try {
    const a = parseArgs(argv, ALL_FLAGS);
    useColor = colorEnabled(process.env, process.stdout.isTTY === true, bool(a, 'no-color'));
    const root = findRoot();
    if (bool(a, 'version')) {
      out.log(`receipts ${packageVersion(root)}`);
      return 0;
    }
    const [name, ...rest] = a.positionals;
    commandName = name;
    if (!name || name === 'help') {
      out.log(usage());
      return name || bool(a, 'help') ? 0 : 1;
    }
    const cmd = COMMANDS[name];
    if (!cmd) throw new UsageError(`Unknown command "${name}".`);
    const allowed = { ...GLOBAL_FLAGS, ...cmd.flags };
    const stray = Object.keys(a.flags).find((f) => !(f in allowed));
    if (stray) throw new UsageError(`"receipts ${name}" has no --${stray} option.`, name);
    if (bool(a, 'help')) {
      out.log(`${cmd.summary}.\n\nUsage: ${cmd.usage}`);
      return 0;
    }
    loadRootEnv(root);
    const cfg = loadConfig({
      ledgerPath: str(a, 'ledger'),
      today: dateFlag(a, 'today'),
      llmMode: bool(a, 'offline') ? 'replay' : undefined,
    });
    return await cmd.run({ cfg }, { positionals: rest, flags: a.flags });
  } catch (err) {
    if (err instanceof UsageError) {
      const cmd = err.command ?? (commandName && COMMANDS[commandName] ? commandName : undefined);
      console.error(`${red('error:')} ${err.message}`);
      console.error(cmd ? `Usage: ${COMMANDS[cmd]!.usage}` : 'Run "receipts --help" for the list of commands.');
      return 1;
    }
    console.error(`${red('error:')} ${plainError(err)}`);
    const hint = hintFor(err);
    if (hint) console.error(dim(hint));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
