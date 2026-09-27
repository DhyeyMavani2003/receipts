// Adapter over the `gbrain` CLI. GBrain is the system of record for people:
// person pages, timeline entries and bet takes live in the user's own brain,
// and `takes scorecard` computes accuracy and Brier from them. The ledger
// keeps the rich fields a take row has no column for.
//
// Every call is an argv array through Bun.spawn, never a shell string, so
// quotes and claim text reach gbrain byte for byte. Free-text values use the
// `--flag=value` form so a value can never be mistaken for another flag.
//
// Facts about gbrain v0.59 this module relies on (checked against the CLI):
// - `get <slug> --include-content --json` returns `content` (the exact page
//   markdown, same bytes as plain `get`) and `revision`; a missing page exits
//   1 with `{"error":"page_not_found"}` on stdout.
// - `put <slug>` reads markdown from stdin; without --expected-revision it is
//   create-only (an existing page fails with revision_conflict).
// - `timeline-add` dedupes exact replays; `takes add` does not, so the
//   ledger's row numbers (plus a match against existing takes) keep sync
//   idempotent.
// - `takes resolve` accepts correct|incorrect|partial|unresolvable and is
//   immutable: any second resolve of a row fails, even with the same quality.
// - `takes scorecard` counts every resolved take, whatever its kind, so only
//   predictions (kind bet) are ever resolved here; that keeps it equal to
//   score.ts, which only scores predictions.
// - `takes add` rejects values that start with "--", even in --flag=value form.

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chains } from './drift.ts';
import { claimsFor } from './ledger.ts';
import { scorePerson } from './score.ts';
import type { Claim, ClaimType, GBrainLink, Ledger, PersonScore, Verdict } from './types.ts';

export interface GBrainOptions {
  bin: string;
  home?: string;
  /**
   * Working directory for gbrain processes. Defaults to the temp dir: gbrain
   * drops GBRAIN_HOME when a .env in its working directory assigns it (as
   * the repo's .env can), and would then write to another brain.
   */
  cwd?: string;
  /** Print mutating commands instead of running them. Reads still run. */
  dryRun?: boolean;
  /** Where dry-run commands and warnings go. Defaults to console.log. */
  log?: (line: string) => void;
}

export const TRACK_RECORD_BEGIN = '<!-- receipts:track-record:begin -->';
export const TRACK_RECORD_END = '<!-- receipts:track-record:end -->';
export const RESOLVED_BY = 'receipts';

const COMMAND_TIMEOUT_MS = 120_000;
const ERROR_TAIL_CHARS = 600;

export type TakeKind = 'bet' | 'take' | 'fact';
export type TakeQuality = 'correct' | 'incorrect' | 'partial' | 'unresolvable';

/** One row of `gbrain takes <slug> --json`, reduced to the fields Receipts reads. */
export interface TakeRow {
  row_num: number;
  claim: string;
  kind: string;
  holder: string;
  weight: number;
  source: string | null;
  active: boolean;
  resolved_quality: string | null;
}

export class GBrainMissingError extends Error {
  constructor(bin: string) {
    super(
      `gbrain CLI not found (tried "${bin}"). Install GBrain with "bun install -g github:garrytan/gbrain" ` +
        'and run "gbrain init", or set GBRAIN_BIN to the gbrain executable.',
    );
    this.name = 'GBrainMissingError';
  }
}

/** A person page the ledger expected is not in this brain (a new or different GBRAIN_HOME). */
export class MissingPageError extends Error {
  constructor(readonly slug: string) {
    super(`${slug} is not in this brain. Run "receipts sync --rebuild" to write the ledger into it from scratch.`);
    this.name = 'MissingPageError';
  }
}

export class GBrainError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number,
    /** gbrain's error code, e.g. "page_not_found", "revision_conflict", "invalid_params". */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'GBrainError';
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// ---- Text and argv builders (pure) ------------------------------------------

export function personPage(personSlug: string): string {
  return `people/${personSlug}`;
}

/**
 * One line of free text safe for a takes-table cell or a CLI value: no pipes
 * (they split the takes table), no newlines, and no leading dashes (gbrain
 * rejects values that look like flags).
 */
export function cleanText(s: string): string {
  return s
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^-+\s*/, '');
}

/** One line, no leading dashes, pipes kept: for timeline text, where the quote must stay verbatim. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/^-+\s*/, '');
}

export function takeKind(type: ClaimType): TakeKind {
  if (type === 'prediction') return 'bet';
  if (type === 'stance') return 'take';
  return 'fact';
}

/** GBrain resolution quality for a verdict; null when the take must stay open. */
export function gbrainQuality(v: Verdict): TakeQuality | null {
  return v === 'correct' || v === 'incorrect' || v === 'partial' || v === 'unresolvable' ? v : null;
}

/** Weights go to gbrain as short decimals (0.85, not 0.8500000000000001). */
export function formatWeight(p: number): string {
  return String(Number(p.toFixed(4)));
}

function linkOf(c: Claim): string {
  return c.source.deepLink ?? c.source.url;
}

function evidenceUrl(c: Claim): string | undefined {
  return c.grading?.evidence?.[0]?.url;
}

export function takeClaimText(c: Claim): string {
  const text = cleanText(c.claim);
  return c.targetDate ? `${text} (deadline ${c.targetDate})` : text;
}

export function takeSource(c: Claim): string {
  return cleanText(`${c.source.title} ${c.saidDate} ${linkOf(c)}`);
}

/** Where a claim sits among the claims that share its quote: "claim 2 of 3". */
export interface SharedQuote {
  index: number;
  total: number;
}

/**
 * The timeline line for a claim. GBrain keys a timeline entry by page, date
 * and summary, and rejects a second entry with the same key but a different
 * detail. Extraction can split one sentence into several claims that share a
 * quote, so every claim after the first in such a group says which one it is.
 * The first keeps the plain summary, so brains synced before this rule match.
 */
export function timelineSummary(c: Claim, shared?: SharedQuote): string {
  const base = oneLine(`${c.source.title} — "${oneLine(c.quote)}" ${linkOf(c)}`);
  return shared && shared.index > 1 ? `${base} (claim ${shared.index} of ${shared.total} from this quote)` : base;
}

/**
 * For each claim whose plain timeline summary and date it shares with other
 * claims of the same person: its place in that group, in ledger order.
 * Claims with a unique summary are not in the map.
 */
export function sharedQuotes(claims: readonly Claim[]): Map<string, SharedQuote> {
  const groups = new Map<string, Claim[]>();
  for (const c of claims) {
    const key = `${c.personSlug}\u0000${c.saidDate}\u0000${timelineSummary(c)}`;
    const group = groups.get(key) ?? [];
    group.push(c);
    groups.set(key, group);
  }
  const out = new Map<string, SharedQuote>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.forEach((c, i) => out.set(c.id, { index: i + 1, total: group.length }));
  }
  return out;
}

export function timelineDetail(c: Claim): string {
  const parts = [
    `receipts: type=${c.type}`,
    `topic=${c.topic}`,
    `due=${c.targetDate ?? 'none'}`,
    `hedge="${oneLine(c.hedge)}"`,
    `p=${formatWeight(c.impliedProbability)}`,
  ];
  // The quote is shown in quotation marks; say so when it was not string-matched.
  if (!c.quoteVerified) parts.push('quote=unverified');
  return parts.join(' ');
}

export function timelineAddArgs(c: Claim, shared?: SharedQuote): string[] {
  return ['timeline-add', personPage(c.personSlug), c.saidDate, `--summary=${timelineSummary(c, shared)}`, `--detail=${timelineDetail(c)}`];
}

export function takesAddArgs(c: Claim): string[] {
  const page = personPage(c.personSlug);
  return [
    'takes', 'add', page,
    `--claim=${takeClaimText(c)}`,
    '--kind', takeKind(c.type),
    '--who', page,
    '--weight', formatWeight(c.impliedProbability),
    `--source=${takeSource(c)}`,
    '--since', c.saidDate.slice(0, 7),
  ];
}

export function takesResolveArgs(page: string, row: number, quality: TakeQuality, evidenceUrl?: string): string[] {
  const evidence = evidenceUrl ? cleanText(evidenceUrl) : '';
  return [
    'takes', 'resolve', page,
    '--row', String(row),
    '--quality', quality,
    ...(evidence ? [`--evidence=${evidence}`] : []),
    '--by', RESOLVED_BY,
  ];
}

export function putArgs(slug: string, expectedRevision?: string): string[] {
  return expectedRevision ? ['put', slug, '--expected-revision', expectedRevision] : ['put', slug];
}

/** How an argv would look typed into a shell. Display only; nothing is ever run through a shell. */
export function displayCommand(bin: string, args: string[]): string {
  return [bin, ...args].map((a) => (/^[\w@%+=:,./#-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(' ');
}

// ---- Output parsers (pure) ---------------------------------------------------

/** Row number from `takes add` output: "Added take #N to <slug>." or the --json `row_num`. */
export function parseAddedTakeRow(stdout: string): number {
  const m = stdout.match(/Added take #(\d+)/);
  if (m) return Number(m[1]);
  try {
    const row = (parseJsonOutput(stdout) as { row_num?: unknown }).row_num;
    if (typeof row === 'number' && Number.isSafeInteger(row) && row > 0) return row;
  } catch {
    // fall through to the error below
  }
  throw new Error(`gbrain takes add: no "Added take #N" in output: ${stdout.trim().slice(0, 200)}`);
}

/**
 * JSON from a gbrain command's stdout. Tolerates notices printed before the
 * JSON: the first line that starts with "{" or "[" begins the document.
 */
export function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^[[{]/.test(lines[i]!)) continue;
      try {
        return JSON.parse(lines.slice(i).join('\n'));
      } catch {
        // try the next candidate line
      }
    }
  }
  throw new Error(`gbrain did not print JSON: ${text.slice(0, 200)}`);
}

/** gbrain's error code from a failed command: `Error [code]:` on stderr or `{"error": code}` on stdout. */
export function parseErrorCode(stdout: string, stderr: string): string | undefined {
  const m = stderr.match(/Error \[([a-z_]+)\]/);
  if (m) return m[1];
  try {
    const err = (parseJsonOutput(stdout) as { error?: unknown }).error;
    return typeof err === 'string' ? err : undefined;
  } catch {
    return undefined;
  }
}

export function parsePageRead(stdout: string): { content: string; revision: string } {
  const page = parseJsonOutput(stdout) as { content?: unknown; revision?: unknown };
  if (typeof page.content !== 'string' || typeof page.revision !== 'string') {
    throw new Error('gbrain get --include-content --json returned no content/revision');
  }
  return { content: page.content, revision: page.revision };
}

export function parseTakeRows(stdout: string): TakeRow[] {
  const rows = parseJsonOutput(stdout);
  if (!Array.isArray(rows)) throw new Error('gbrain takes --json did not return a list');
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .filter((r) => typeof r.row_num === 'number' && typeof r.claim === 'string')
    .map((r) => ({
      row_num: r.row_num as number,
      claim: r.claim as string,
      kind: String(r.kind ?? ''),
      holder: String(r.holder ?? ''),
      weight: typeof r.weight === 'number' ? r.weight : NaN,
      source: typeof r.source === 'string' ? r.source : null,
      active: r.active !== false,
      resolved_quality: typeof r.resolved_quality === 'string' ? r.resolved_quality : null,
    }));
}

/** The existing take that is this claim, if any: same page holder, kind, claim text and source. */
export function findMatchingTake(c: Claim, rows: TakeRow[], taken: ReadonlySet<number> = new Set()): TakeRow | undefined {
  const holder = personPage(c.personSlug);
  const claim = takeClaimText(c);
  const source = takeSource(c);
  const kind = takeKind(c.type);
  return rows.find(
    (r) => r.active && !taken.has(r.row_num) && r.holder === holder && r.kind === kind && r.claim === claim && (r.source ?? '') === source,
  );
}

// ---- Person template and track record (pure) --------------------------------

// GBrain's Person template (docs/GBRAIN_RECOMMENDED_SCHEMA.md). Empty sections
// stay as "[No data yet]" so future enrichment knows what to look for. The
// Timeline section is left out on purpose: gbrain creates and owns it (behind
// a `<!-- timeline -->` sentinel) on the first timeline-add.
const PERSON_SECTIONS = [
  'State',
  'What They Believe',
  "What They're Building",
  'What Motivates Them',
  'Communication Style',
  'Hobby Horses',
  'Assessment',
  'Trajectory',
  'Relationship',
  'Contact',
  'Network',
  'Open Threads',
];

function yamlScalar(s: string): string {
  return /^[A-Za-z0-9][\w .'-]*$/.test(s) ? s : JSON.stringify(s);
}

export function personTemplate(name: string): string {
  const title = name.replace(/\s+/g, ' ').trim();
  return [
    '---',
    'type: person',
    `title: ${yamlScalar(title)}`,
    'tags: [receipts]',
    '---',
    `# ${title}`,
    '',
    '> Public figure tracked by Receipts: a track record on public statements.',
    '',
    ...PERSON_SECTIONS.flatMap((s) => [`## ${s}`, '[No data yet]', '']),
  ].join('\n');
}

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${Math.round(x * 100)}%`;
}

/** The whole marker-delimited block, markers included. Deterministic, so an unchanged score rewrites nothing. */
export function renderTrackRecord(score: PersonScore, chainsText: string[]): string {
  const resolved = score.correct + score.incorrect;
  const lines = [
    TRACK_RECORD_BEGIN,
    '## Track Record',
    '',
    '_Track record on public statements, compiled by Receipts from dated, verbatim quotes. Verdicts are AI-assisted; every one links its evidence._',
    '',
    `- **Claims tracked:** ${score.claims} (${score.predictions} predictions)`,
    `- **Predictions:** ${score.correct} correct, ${score.incorrect} incorrect, ${score.partial} partial, ` +
      `${score.unresolvable} unresolvable, ${score.tooEarly} too early, ${score.pending} pending`,
    `- **Accuracy:** ${pct(score.accuracy)} (${score.correct} of ${resolved} resolved correct/incorrect)`,
    `- **Brier:** ${score.brier === null ? 'n/a' : score.brier.toFixed(3)} (coin-flip baseline 0.25; lower is better)`,
  ];
  if (score.latenessMultiplier !== null) {
    lines.push(`- **Lateness:** ${score.latenessMultiplier.toFixed(1)}× the promised time (median of late-but-true predictions)`);
  }
  lines.push(`- **Drift events:** ${score.driftEvents}`);
  if (score.byTopic.length) {
    lines.push('', '### By topic');
    for (const t of score.byTopic) {
      lines.push(`- ${t.topic}: ${t.predictions} predictions, ${t.correct} correct, ${t.incorrect} incorrect, ${t.partial} partial (accuracy ${pct(t.accuracy)})`);
    }
  }
  if (chainsText.length) {
    lines.push('', '### Story drift');
    for (const line of chainsText) lines.push(`- ${cleanText(line)}`);
  }
  lines.push(TRACK_RECORD_END);
  return lines.join('\n');
}

const DRIFT_WORDS: Record<string, string> = {
  pushed_later: 'pushed later',
  pulled_earlier: 'pulled earlier',
  goalposts_moved: 'goalposts moved',
  reversed: 'reversed',
  escalated: 'escalated',
  softened: 'softened',
};

/** One line per topic with 2+ claims: the deadlines in order, then the drift labels seen. */
export function driftChainLines(l: Ledger, personSlug: string): string[] {
  return chains(l)
    .filter((ch) => ch.personSlug === personSlug && ch.claims.length >= 2)
    .map((ch) => {
      const steps = ch.claims.map((c) => c.targetDate ?? `no deadline (said ${c.saidDate})`).join(' → ');
      const counts = new Map<string, number>();
      for (const c of ch.claims) {
        const word = c.drift ? DRIFT_WORDS[c.drift.label] : undefined;
        if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
      }
      const labels = [...counts].map(([w, n]) => (n > 1 ? `${w} ×${n}` : w)).join(', ');
      return `${ch.topic}: ${steps}${labels ? ` (${labels})` : ''}`;
    });
}

interface Line {
  text: string;
  start: number;
  end: number; // offset just past the line's newline
}

function linesOf(md: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < md.length) {
    const nl = md.indexOf('\n', start);
    const end = nl < 0 ? md.length : nl + 1;
    out.push({ text: md.slice(start, nl < 0 ? md.length : nl), start, end });
    start = end;
  }
  return out;
}

function isTimelineStart(text: string): boolean {
  return text.trim() === '<!-- timeline -->' || /^##\s+Timeline\s*$/.test(text);
}

// Right after the H1 and its "> summary" lines; before the timeline if the
// page has no H1 ahead of it; after the frontmatter as a last resort.
function trackRecordOffset(md: string): number {
  const lines = linesOf(md);
  let i = 0;
  if (lines[0]?.text === '---') {
    const close = lines.findIndex((l, k) => k > 0 && l.text === '---');
    if (close > 0) i = close + 1;
  }
  const afterFrontmatter = lines[i]?.start ?? md.length;
  for (let k = i; k < lines.length; k++) {
    if (isTimelineStart(lines[k]!.text)) return lines[k]!.start;
    if (!/^# /.test(lines[k]!.text)) continue;
    let j = k + 1;
    while (j < lines.length && lines[j]!.text.trim() === '') j++;
    if (j < lines.length && lines[j]!.text.startsWith('>')) {
      while (j < lines.length && lines[j]!.text.startsWith('>')) j++;
      return lines[j - 1]!.end;
    }
    return lines[k]!.end;
  }
  return afterFrontmatter;
}

/**
 * Put `block` (markers included) into the page: replace the existing
 * marker-delimited block, or insert one after the H1 + summary. Every byte
 * outside the block is kept as is, including the takes fence and timeline.
 */
export function spliceTrackRecord(markdown: string, block: string): string {
  const begin = markdown.indexOf(TRACK_RECORD_BEGIN);
  if (begin >= 0) {
    const end = markdown.indexOf(TRACK_RECORD_END, begin);
    if (end < 0) throw new Error(`track-record block has "${TRACK_RECORD_BEGIN}" but no "${TRACK_RECORD_END}"; fix the page by hand`);
    return markdown.slice(0, begin) + block + markdown.slice(end + TRACK_RECORD_END.length);
  }
  const at = trackRecordOffset(markdown);
  const before = markdown.slice(0, at);
  const after = markdown.slice(at);
  const lead = at === 0 || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after === '' || after.startsWith('\n') ? '\n' : '\n\n';
  return before + lead + block + trail + after;
}

// ---- The adapter -------------------------------------------------------------

function tail(s: string): string {
  const t = s.trim();
  return t.length > ERROR_TAIL_CHARS ? `…${t.slice(-ERROR_TAIL_CHARS)}` : t;
}

function isImmutableError(err: unknown): boolean {
  return err instanceof GBrainError && /immutable/i.test(err.message);
}

// gbrain's PGLite lock: another gbrain process (usually `gbrain serve` for an MCP client) has the brain open.
const BRAIN_BUSY_RE = /pglite_busy|already open through `?gbrain serve|Timed out waiting for PGLite data-dir lock/i;

export const BRAIN_BUSY_HINT =
  'The brain is open in another gbrain process, usually "gbrain serve" started by Claude Code or another MCP client. ' +
  'Quit that client (or stop the server), then run "receipts sync".';

// Errors no other person's sync could get past: stop instead of failing each person in turn.
function isFatal(err: unknown): boolean {
  return (
    err instanceof GBrainMissingError ||
    (err instanceof GBrainError && err.code === 'pglite_busy') ||
    (err instanceof Error && /No brain configured|GBRAIN_DB_ACCESS/.test(err.message))
  );
}

interface SyncState {
  created: boolean;
  touched: boolean;
  takes?: TakeRow[];          // the page's takes as they were before this run
  usedRows: Set<number>;      // rows already linked to a ledger claim
  addedRows: Set<number>;     // rows this run appended
}

export class GBrain {
  private readonly bin: string;
  private readonly home?: string;
  private readonly cwd?: string;
  private readonly dryRun: boolean;
  private readonly log: (line: string) => void;

  constructor(opts: GBrainOptions) {
    this.bin = opts.bin;
    this.home = opts.home;
    this.cwd = opts.cwd;
    this.dryRun = opts.dryRun ?? false;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  // -- process plumbing --

  // GBRAIN_HOME is always passed explicitly; empty means gbrain's default brain.
  private env(): Record<string, string | undefined> {
    return { ...process.env, GBRAIN_HOME: this.home ?? process.env.GBRAIN_HOME ?? '' };
  }

  private async spawn(args: string[], stdin?: string): Promise<RunResult> {
    const cwd = this.cwd ?? tmpdir();
    if (!existsSync(cwd)) throw new Error(`gbrain working directory does not exist: ${cwd}`);
    let proc;
    try {
      proc = Bun.spawn([this.bin, ...args], {
        cwd,
        env: this.env(),
        stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT' || code === 'EACCES') throw new GBrainMissingError(this.bin);
      throw err;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, COMMAND_TIMEOUT_MS);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (timedOut) throw new GBrainError(`gbrain ${args.slice(0, 2).join(' ')} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`, args, code);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  private failure(args: string[], r: RunResult): GBrainError {
    const detail = tail(r.stderr) || tail(r.stdout) || '(no output)';
    if (BRAIN_BUSY_RE.test(`${r.stderr}\n${r.stdout}`)) {
      return new GBrainError(`${BRAIN_BUSY_HINT} (gbrain ${args.slice(0, 2).join(' ')} exited ${r.code}: ${detail})`, args, r.code, 'pglite_busy');
    }
    return new GBrainError(`gbrain ${args.slice(0, 2).join(' ')} exited ${r.code}: ${detail}`, args, r.code, parseErrorCode(r.stdout, r.stderr));
  }

  /** Run a read-only command; non-zero exit throws. */
  private async read(args: string[]): Promise<string> {
    const r = await this.spawn(args);
    if (r.code !== 0) throw this.failure(args, r);
    return r.stdout;
  }

  /** Run a mutating command, or print it in dry-run mode (returns null then). */
  private async mutate(args: string[], stdin?: string): Promise<string | null> {
    if (this.dryRun) {
      const input = stdin === undefined ? '' : `  <<< stdin: ${stdin.split('\n').length} lines of markdown`;
      this.log(`[dry-run] ${displayCommand('gbrain', args)}${input}`);
      return null;
    }
    const r = await this.spawn(args, stdin);
    if (r.code !== 0) throw this.failure(args, r);
    return r.stdout;
  }

  // -- public API --

  /** `gbrain --version` output, or null when gbrain is missing or broken. */
  async version(): Promise<string | null> {
    try {
      const r = await this.spawn(['--version']);
      return r.code === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  async available(): Promise<boolean> {
    return (await this.version()) !== null;
  }

  /**
   * Touch the brain through the same spawn path the sync uses: reading a page
   * that cannot exist must answer page_not_found. Returns null when the brain
   * answers, else what went wrong (e.g. "No brain configured").
   */
  async brainProblem(): Promise<string | null> {
    try {
      await this.readPage('people/receipts-doctor-probe-page-that-does-not-exist');
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }

  /** Page markdown and revision; null when the page does not exist. */
  async readPage(slug: string): Promise<{ content: string; revision: string } | null> {
    const args = ['get', slug, '--include-content', '--json'];
    const r = await this.spawn(args);
    if (r.code === 0) return parsePageRead(r.stdout);
    if (parseErrorCode(r.stdout, r.stderr) === 'page_not_found') return null;
    throw this.failure(args, r);
  }

  async getPage(slug: string): Promise<string | null> {
    return (await this.readPage(slug))?.content ?? null;
  }

  /**
   * Write a whole page from markdown on stdin. With no expectedRevision the
   * current revision is looked up, so this creates or replaces.
   */
  async putPage(slug: string, markdown: string, expectedRevision?: string): Promise<void> {
    const revision = expectedRevision ?? (this.dryRun ? undefined : (await this.readPage(slug))?.revision);
    await this.mutate(putArgs(slug, revision), markdown);
  }

  async ensurePerson(personSlug: string, name: string): Promise<'created' | 'exists'> {
    const slug = personPage(personSlug);
    if ((await this.readPage(slug)) !== null) return 'exists';
    // No revision: create-only, so a page someone else just made is never overwritten.
    await this.mutate(putArgs(slug), personTemplate(name));
    return 'created';
  }

  async addTimeline(c: Claim, shared?: SharedQuote): Promise<void> {
    await this.mutate(timelineAddArgs(c, shared));
  }

  /** Append the claim's take; returns its row number (0 in dry-run mode, where nothing is written). */
  async addTake(c: Claim): Promise<number> {
    const out = await this.mutate(takesAddArgs(c));
    return out === null ? 0 : parseAddedTakeRow(out);
  }

  async listTakes(personSlug: string): Promise<TakeRow[]> {
    return parseTakeRows(await this.read(['takes', personPage(personSlug), '--json']));
  }

  /**
   * Record the verdict on the claim's bet. Only graded predictions with a row
   * are resolved. Returns true when GBrain holds this quality afterwards
   * (including when it already did), false when skipped or when GBrain keeps
   * an earlier, different resolution (resolutions are immutable).
   */
  async resolveTake(c: Claim): Promise<boolean> {
    const quality = resolvableQuality(c);
    const row = c.gbrain?.row;
    if (!quality || !row) return false;
    return (await this.resolveRow(c, row, quality)) === quality;
  }

  /** Returns the quality GBrain holds for the row afterwards (null in dry-run mode). */
  private async resolveRow(c: Claim, row: number, quality: TakeQuality): Promise<string | null> {
    const page = personPage(c.personSlug);
    try {
      const out = await this.mutate(takesResolveArgs(page, row, quality, evidenceUrl(c)));
      return out === null ? null : quality;
    } catch (err) {
      if (!isImmutableError(err)) throw err;
      const held = (await this.listTakes(c.personSlug)).find((t) => t.row_num === row)?.resolved_quality ?? null;
      if (held !== quality) this.warnConflict(page, row, held, quality);
      return held;
    }
  }

  private warnConflict(page: string, row: number, held: string | null, wanted: string): void {
    this.log(`gbrain: ${page} take #${row} is already resolved as ${held ?? 'unknown'}; the ledger says ${wanted}. GBrain keeps the first resolution.`);
  }

  async scorecard(personSlug: string): Promise<Record<string, unknown> | null> {
    const out = await this.read(['takes', 'scorecard', personPage(personSlug), '--json']);
    const card = parseJsonOutput(out);
    return card && typeof card === 'object' && !Array.isArray(card) ? (card as Record<string, unknown>) : null;
  }

  /** Replace or insert the track-record block; no write when it is unchanged. Retries once on a revision conflict. */
  async writeTrackRecord(personSlug: string, score: PersonScore, chainsText: string[]): Promise<void> {
    const slug = personPage(personSlug);
    const block = renderTrackRecord(score, chainsText);
    for (let attempt = 1; ; attempt++) {
      const page = await this.readPage(slug);
      if (!page) {
        if (this.dryRun) return void this.log(`[dry-run] ${displayCommand('gbrain', putArgs(slug))}  <<< track-record block into the new page`);
        throw new MissingPageError(slug);
      }
      const next = spliceTrackRecord(page.content, block);
      if (next === page.content) return;
      try {
        await this.mutate(putArgs(slug, page.revision), next);
        return;
      } catch (err) {
        if (attempt >= 2 || !(err instanceof GBrainError) || err.code !== 'revision_conflict') throw err;
      }
    }
  }

  /**
   * Push the ledger into GBrain, idempotently: person page, one timeline entry
   * and one take per claim, resolutions for graded predictions, then the
   * track-record block for every person whose brain rows changed, or who is
   * in `refresh` (their drift moved), or every person in scope with
   * trackRecord: 'all'. Each block is written at most once. Updates claim.gbrain in place
   * as each step lands, so `l` keeps the progress even when a later step
   * throws. Dry-run prints the plan and leaves `l` untouched.
   */
  async syncClaims(
    l: Ledger,
    opts: { personSlug?: string; onProgress?: (m: string) => void; trackRecord?: 'touched' | 'all'; refresh?: Iterable<string> } = {},
  ): Promise<Ledger> {
    const progress = opts.onProgress ?? (() => {});
    const refresh = new Set(opts.refresh ?? []);
    const failures: string[] = [];
    for (const personSlug of peopleInScope(l, opts.personSlug)) {
      try {
        const { touched, failed } = await this.syncPerson(l, personSlug, progress);
        for (const f of failed) failures.push(`${personSlug}: ${f}`);
        if (touched || opts.trackRecord === 'all' || refresh.has(personSlug)) {
          await this.refreshTrackRecord(l, personSlug, progress);
          progress(`${personPage(personSlug)}: track record refreshed`);
        }
      } catch (err) {
        if (isFatal(err)) throw err;
        failures.push(`${personSlug}: ${(err as Error).message}`);
        progress(`${personPage(personSlug)}: sync failed: ${(err as Error).message}`);
      }
    }
    if (failures.length) throw new Error(`gbrain sync failed for ${failures.length} ${failures.length === 1 ? 'item' : 'items'}:\n${failures.join('\n')}`);
    return l;
  }

  /**
   * Sync one person's claims; returns whether anything was written and which
   * claims failed. One claim gbrain rejects does not stop the others: each
   * failure is reported, and the rest of the person still syncs. A page
   * that has to be created while the ledger holds links for it means the
   * links point into another brain: they are dropped and every claim is
   * written from scratch.
   */
  private async syncPerson(l: Ledger, personSlug: string, progress: (m: string) => void): Promise<{ touched: boolean; failed: string[] }> {
    const page = personPage(personSlug);
    let pending = claimsFor(l, personSlug).filter(needsSync);
    if (!pending.length) return { touched: false, failed: [] };

    const created = (await this.ensurePerson(personSlug, pending[0]!.person)) === 'created';
    if (created) progress(`${page}: created person page`);
    if (created && !this.dryRun && forgetBrainLinks(l, personSlug) > 0) {
      progress(`${page}: was not in this brain; writing every claim again`);
      pending = claimsFor(l, personSlug);
    }
    const state: SyncState = {
      created,
      touched: created,
      usedRows: new Set(claimsFor(l, personSlug).flatMap((c) => (c.gbrain?.row ? [c.gbrain.row] : []))),
      addedRows: new Set(),
    };
    const shared = sharedQuotes(claimsFor(l, personSlug));
    const failed: string[] = [];
    for (const c of pending) {
      try {
        const updated = await this.syncClaim(c, state, progress, shared.get(c.id));
        if (!this.dryRun) replaceClaim(l, updated);
      } catch (err) {
        if (isFatal(err)) throw err;
        const message = `"${truncate(c.claim, 60)}" (${c.id}): ${(err as Error).message}`;
        failed.push(message);
        progress(`${page}: not synced: ${message}`);
      }
    }
    return { touched: state.touched, failed };
  }

  // A fully synced person whose page is gone (a new or re-initialized brain):
  // drop the stale links, write the person again, then the block.
  private async refreshTrackRecord(l: Ledger, personSlug: string, progress: (m: string) => void): Promise<void> {
    const write = () => this.writeTrackRecord(personSlug, scorePerson(claimsFor(l, personSlug)), driftChainLines(l, personSlug));
    try {
      await write();
    } catch (err) {
      if (!(err instanceof MissingPageError) || this.dryRun) throw err;
      forgetBrainLinks(l, personSlug);
      progress(`${personPage(personSlug)}: was not in this brain; writing every claim again`);
      await this.syncPerson(l, personSlug, progress);
      await write();
    }
  }

  // A fresh page has no takes; otherwise read them once per person.
  private async existingTakes(personSlug: string, state: SyncState): Promise<TakeRow[]> {
    if (state.created) state.takes ??= [];
    state.takes ??= await this.listTakes(personSlug);
    return state.takes;
  }

  private async syncClaim(c: Claim, state: SyncState, progress: (m: string) => void, shared?: SharedQuote): Promise<Claim> {
    const page = personPage(c.personSlug);
    const link: GBrainLink = { ...c.gbrain, page };

    if (!link.timelineWritten) {
      await this.addTimeline(c, shared);
      link.timelineWritten = true;
      state.touched = true;
      progress(`${page}: timeline ${c.saidDate} "${truncate(c.quote, 60)}"`);
    }

    if (link.row === undefined) {
      const match = findMatchingTake(c, await this.existingTakes(c.personSlug, state), state.usedRows);
      if (match) {
        link.row = match.row_num;
        progress(`${page}: take #${match.row_num} already in GBrain`);
      } else {
        const row = await this.addTake(c);
        if (row > 0) {
          link.row = row;
          state.addedRows.add(row);
        }
        state.touched = true;
        progress(`${page}: take #${row || '?'} (${takeKind(c.type)} p=${formatWeight(c.impliedProbability)})`);
      }
      if (link.row) state.usedRows.add(link.row);
    }

    const quality = resolvableQuality(c);
    if (quality && link.resolvedQuality === undefined) {
      const held = await this.resolveForSync(c, link, quality, state);
      if (held !== null) link.resolvedQuality = held;
      if (held === quality) progress(`${page}: take #${link.row} resolved as ${quality}`);
    } else if (quality && link.resolvedQuality !== quality && link.row) {
      // Regraded after GBrain resolved it: resolutions are immutable, so say so every sync.
      this.warnConflict(page, link.row, link.resolvedQuality ?? null, quality);
    }
    return { ...c, gbrain: link };
  }

  // Never re-resolve (resolutions are immutable) and never resolve a row
  // that is not this claim's take: a ledger synced against another brain
  // would point at someone else's row. Rows appended this run need no check.
  private async resolveForSync(c: Claim, link: GBrainLink, quality: TakeQuality, state: SyncState): Promise<string | null> {
    const page = personPage(c.personSlug);
    if (!link.row) {
      if (this.dryRun) {
        const args = takesResolveArgs(page, 1, quality, evidenceUrl(c));
        args[args.indexOf('--row') + 1] = '<row from takes add>';
        this.log(`[dry-run] ${displayCommand('gbrain', args)}`);
      }
      return null;
    }
    if (!state.addedRows.has(link.row)) {
      const known = (await this.existingTakes(c.personSlug, state)).find((t) => t.row_num === link.row);
      if (!known || known.claim !== takeClaimText(c)) {
        this.log(`gbrain: ${page} take #${link.row} is not "${truncate(takeClaimText(c), 60)}"; not resolving it.`);
        return null;
      }
      if (known.resolved_quality) {
        if (known.resolved_quality !== quality) this.warnConflict(page, link.row, known.resolved_quality, quality);
        return known.resolved_quality;
      }
    }
    state.touched = true;
    return this.resolveRow(c, link.row, quality);
  }
}

// ---- sync helpers (pure) -----------------------------------------------------

/**
 * The quality to resolve the claim's take with, or null. A disputed grading
 * (the judges split, so no verdict is recorded) is never resolved: GBrain
 * resolutions are permanent, and a later regrade must still be able to land.
 */
export function resolvableQuality(c: Claim): TakeQuality | null {
  if (c.type !== 'prediction' || c.grading?.disputed) return null;
  return gbrainQuality(c.verdict);
}

/** Whether a claim still has anything to push to GBrain, or a resolution that differs from its verdict (to warn about). */
export function needsSync(c: Claim): boolean {
  const g = c.gbrain;
  if (!g?.timelineWritten || g.row === undefined) return true;
  const quality = resolvableQuality(c);
  return quality !== null && g.resolvedQuality !== quality;
}

function peopleInScope(l: Ledger, personSlug?: string): string[] {
  const slugs = new Set(l.claims.map((c) => c.personSlug));
  if (personSlug !== undefined) return slugs.has(personSlug) ? [personSlug] : [];
  return [...slugs].sort();
}

/**
 * Drop the GBrain links of claims in scope (one person, or everyone), so the
 * next sync writes them again; existing takes are matched, not duplicated.
 * Mutates `l`; returns how many links were dropped.
 */
export function forgetBrainLinks(l: Ledger, personSlug?: string): number {
  let dropped = 0;
  l.claims = l.claims.map((c) => {
    if (!c.gbrain || (personSlug !== undefined && c.personSlug !== personSlug)) return c;
    dropped++;
    const { gbrain: _gone, ...rest } = c;
    return rest;
  });
  return dropped;
}

function replaceClaim(l: Ledger, updated: Claim): void {
  const i = l.claims.findIndex((c) => c.id === updated.id);
  if (i >= 0) l.claims[i] = updated;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
