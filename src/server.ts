// Live Receipts app (Bun.serve). Pages render from the ledger file on every
// request, so the CLI and the server can share data/ledger.json. POST
// /api/ingest runs the whole pipeline for one episode and streams progress as
// server-sent events: load -> extract -> save -> grade -> drift -> GBrain sync,
// saving the ledger after every stage so a failure or a closed tab loses
// nothing already done. Ingests run one at a time (409 while busy).
//
// The pipeline functions are injectable (ServerDeps) so tests can drive the
// routes without a model, network or gbrain binary.

import { basename, extname } from 'node:path';

import { answerQuestion, ask, possessiveName } from './ask.ts';
import { discoverAppearances, isPublicHttpUrl, pullCandidate, sourceKey, transcriptSourceOf } from './discover.ts';
import { knownPeople, resolvePeople, routeInput } from './intent.ts';
import { isYouTubeUrl } from './transcript/load.ts';
import { buildFeed } from './site/feed.ts';
import { cardData, peopleData, renderPersonCard as renderPersonCardHtml, relativeTime, renderAnswerCard, renderCandidateRow, renderDashboard, renderDiscoveries, renderPersonV2 } from './site/dashboard.ts';
import type { PersonCardData } from './site/dashboard.ts';
import { PLAIN_VERDICT } from './site/theme.ts';
import type { AppMode } from './site/theme.ts';
import { discoveriesPath, findCandidate, findFollowed, follow, loadDiscoveries, loadWatchlist, markChecked, recordDiscovery, unfollow, watchlistPath } from './watchlist.ts';
import type { Config } from './config.ts';
import { applyDrift, refineDrift } from './drift.ts';
import { extractClaims, topicsForSpeaker } from './extract.ts';
import type { ProgressEvent } from './extract.ts';
import { GBrain } from './gbrain.ts';
import { gradeDue } from './grade.ts';
import { claimsFor, dueClaims, loadLedger, patchClaims, slugify, updateLedger, upsertClaims } from './ledger.ts';
import { LLMUnavailableError, getLLM } from './llm/index.ts';
import type { JsonRequest, JsonResponse } from './llm/provider.ts';
import { ReplayMissError } from './llm/replay.ts';
import { redactSecrets } from './llm/openai.ts';
import type { LLM } from './llm/provider.ts';
import { scoreAll } from './score.ts';
import { ReplayLLM, recordedExcerpts } from './llm/replay.ts';
import { recordedQuestions, renderAskReceipts, renderIndex, renderNotFound, renderReceipt, topicLabel, withDetectedDrift } from './site/render.ts';
import { NOTABLE_DRIFT, VERDICT_LABEL, plural } from './site/theme.ts';
import { AUDIO_EXTENSIONS, TRANSCRIPT_EXTENSIONS, isHttpUrl, loadTranscript } from './transcript/load.ts';
import { SOURCE_KINDS } from './types.ts';
import type { Candidate, Claim, Ledger, SourceKind, SourceRef, Transcript, Watchlist } from './types.ts';

type Server = ReturnType<typeof Bun.serve>;

// ---- Contracts ------------------------------------------------------------------

export interface IngestRequest {
  input: string;
  speaker: string;
  host?: string;
  title?: string;
  date?: string;
  url?: string;
  kind?: SourceKind;
}

export type IngestStage =
  | ProgressEvent['stage']
  | 'load'
  | 'saved'
  | 'grade'
  | 'graded'
  | 'drift'
  | 'sync'
  | 'updated'
  | 'warning'
  | 'complete'
  | 'error';

/** One SSE `data:` payload. Extract's ProgressEvents pass through unchanged, plus rendered card HTML. */
export interface IngestEvent {
  stage: IngestStage;
  message: string;
  claim?: Claim;
  count?: number;
  /** Receipt card, rendered and escaped server-side. */
  html?: string;
  /** Person page link on 'complete'. */
  href?: string;
  /** Speaker name on 'complete' (the page's "See <Name>'s page" link). */
  person?: string;
}

/** The slice of GBrain the server uses. */
export interface GBrainSync {
  available(): Promise<boolean>;
  syncClaims(l: Ledger, opts?: { personSlug?: string; onProgress?: (m: string) => void }): Promise<Ledger>;
}

export interface ServerDeps {
  /** Throws (LLMUnavailableError) when no model is configured. */
  getLLM(cfg: Config): LLM;
  loadTranscript: typeof loadTranscript;
  extractClaims: typeof extractClaims;
  gradeDue: typeof gradeDue;
  refineDrift: typeof refineDrift;
  ask: typeof ask;
  /** null when GBrain should not be used at all. */
  gbrain(cfg: Config, log: (line: string) => void): GBrainSync | null;
  discoverAppearances: typeof discoverAppearances;
  pullCandidate: typeof pullCandidate;
  answerQuestion: typeof answerQuestion;
  routeInput: typeof routeInput;
}

export function defaultDeps(): ServerDeps {
  return {
    getLLM: (cfg) => appLLM(cfg),
    loadTranscript,
    extractClaims,
    gradeDue,
    refineDrift,
    ask,
    gbrain: (cfg, log) => new GBrain({ bin: cfg.gbrainBin, home: cfg.gbrainHome, log }),
    discoverAppearances,
    pullCandidate,
    answerQuestion,
    routeInput,
  };
}

// ---- Live with replay fallback --------------------------------------------------------

/** Where model answers come from: live (key set), offline replay, or recordings only because there is no key. */
export function appMode(cfg: Pick<Config, 'llmMode' | 'openaiKey'>): AppMode {
  if (cfg.llmMode === 'replay') return 'replay';
  return cfg.openaiKey ? 'live' : 'no-key';
}

/**
 * Tries the live model; when it is unreachable (network, timeout, 429, 401)
 * answers from a recording instead. A fallback answer's model id starts with
 * "replay:", which is how the page knows to say it came from a recording.
 */
export class LiveWithReplayLLM implements LLM {
  readonly name = 'openai';
  constructor(
    private readonly live: LLM,
    private readonly replay: LLM,
    private readonly onFallback?: (req: JsonRequest<unknown>, err: Error) => void,
  ) {}

  async json<T>(req: JsonRequest<T>): Promise<JsonResponse<T>> {
    try {
      return await this.live.json(req);
    } catch (err) {
      if (!(err instanceof LLMUnavailableError)) throw err;
      let res: JsonResponse<T>;
      try {
        res = await this.replay.json(req);
      } catch {
        throw err;
      }
      this.onFallback?.(req as JsonRequest<unknown>, err);
      return res.model.startsWith('replay:') ? res : { ...res, model: `replay:${res.model}` };
    }
  }
}

/** The model the app uses: replay for offline and no-key; live (recording when cfg.record) with a replay fallback otherwise. */
export function appLLM(cfg: Config): LLM {
  const replay = new ReplayLLM(cfg.fixturesDir);
  if (appMode(cfg) !== 'live') return replay;
  return new LiveWithReplayLLM(getLLM(cfg), replay, (req, err) => console.log(`live ${req.schemaName} call failed (${plainError(err)}); answered from a recording`));
}

// ---- Human progress lines for /api/pull ---------------------------------------------------

const OFFLINE_NO_RECORDING = 'There is no recording for this, and live mode is off. Add OPENAI_API_KEY to .env and restart with "receipts start".';

/** One short line a first-time viewer can read, for any pipeline error. */
export function friendlyPullError(message: string): string {
  if (/No replay fixture|no recording/i.test(message)) return OFFLINE_NO_RECORDING;
  if (/OPENAI_API_KEY missing/.test(message)) return OFFLINE_NO_RECORDING;
  if (/\b429\b|too many requests|rate.?limit/i.test(message)) return 'YouTube is busy right now and would not hand over the captions. Try again in a minute.';
  if (/yt-dlp|captions|subtitles/i.test(message)) return 'Could not get a transcript for this video. Try another appearance, or a saved transcript file under Advanced.';
  const t = message.replace(/\s+/g, ' ').trim();
  return t.length <= 200 ? t : `${t.slice(0, 199).trimEnd()}…`;
}

/** Rewrites runIngest's events into the plain progress lines of the dashboard. */
export function humanPullEvents(send: Send, speaker: string): Send {
  let dropped = 0;
  return (e) => {
    const m = e.message;
    switch (e.stage) {
      case 'load':
        if (/^Loading |^Loaded /.test(m)) return;
        if (m.startsWith('Replay mode')) return send({ ...e, message: 'Offline replay: the model answers come from recordings, so this is quick.' });
        return send(e);
      case 'chunk': {
        const part = /part (\d+) of (\d+)/i.exec(m);
        return send({ ...e, message: part ? `Reading the transcript (part ${part[1]} of ${part[2]})...` : 'Reading the transcript...' });
      }
      case 'candidates': {
        const n = /(\d+) candid/.exec(m);
        return send({ ...e, message: n ? `Checking ${plural(Number(n[1]), 'quote')} word for word...` : 'Checking quotes word for word...' });
      }
      case 'verified':
      case 'updated':
        return send({ ...e, message: '' });
      case 'dropped':
        dropped++;
        return;
      case 'done':
        return;
      case 'saved':
        send({ ...e, message: `Saved ${plural(e.count ?? 0, 'new receipt')}.` });
        if (dropped) send({ stage: 'warning', message: `${plural(dropped, 'quote')} did not match the transcript word for word and ${dropped === 1 ? 'was' : 'were'} left out.` });
        return;
      case 'grade': {
        if (/^No new prediction/.test(m)) return send({ ...e, message: 'No new prediction has reached its deadline yet.' });
        const g = /^Grading (\d+) predictions? whose deadline has passed/.exec(m);
        if (g) return send({ ...e, message: `Grading ${plural(Number(g[1]), 'prediction')} whose deadline passed...` });
        return send(e);
      }
      case 'graded':
        return send({ ...e, message: e.claim ? `${PLAIN_VERDICT[e.claim.verdict]}: ${e.claim.claim}` : m });
      case 'drift':
        if (m.startsWith('Story drift: ')) return send({ ...e, message: `Story moved: ${m.slice('Story drift: '.length)}` });
        return send({ ...e, message: 'No change against what they said before.' });
      case 'complete':
        return send({ ...e, person: speaker, message: /^No checkable claims/.test(m) ? `No checkable claims by ${speaker} in this source.` : m });
      case 'sync':
        if (/not found/i.test(m)) return send({ ...e, message: 'GBrain is not installed, so the brain was not updated. Everything is saved here.' });
        if (/up to date/i.test(m)) return send({ ...e, message: 'Saved to your brain.' });
        return send({ ...e, message: 'Saving to your brain (GBrain)...' });
      case 'warning':
        if (/GBrain sync failed/.test(m)) return send({ ...e, message: 'Could not save to your brain this time. The receipts are saved here; run "receipts sync" later.' });
        return send(e);
      case 'error':
        return send({ ...e, message: friendlyPullError(m) });
      default:
        return send(e);
    }
  };
}

export interface ServerOptions {
  port: number;
  /** Defaults to loopback: the ingest form reads local file paths. */
  hostname?: string;
  deps?: Partial<ServerDeps>;
  /** Server-side log lines (never contains the API key). Defaults to console.log. */
  log?: (line: string) => void;
  heartbeatMs?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  stop(): void;
}

// ---- Pure helpers -----------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The one example question the README, the CLI hint and the error messages share, so one recording serves all of them. */
export const EXAMPLE_QUESTION = 'How much should I trust Elon Musk on robotaxi timelines?';
const MAX_QUESTION = 500;
const MAX_INPUT = 2048;
const MAX_NAME = 120;
const MAX_TITLE = 300;

/** Error text safe to show a user: key-shaped strings redacted, never empty. */
export function plainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg).trim() || 'Something went wrong.';
}

function shorten(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const YT_RATE_LIMIT_HINT = 'YouTube is rate-limiting this network; save captions with yt-dlp later or ingest a transcript file.';
const YT_OTHER_HINT = 'YouTube did not hand over captions; try again later, or ingest a saved transcript file (.vtt, .srt, .txt).';

/**
 * The part of an ingest error worth showing on the page. A yt-dlp failure
 * carries up to three raw stderr lines; the page gets only the final
 * "ERROR:" line plus a hint, and the server console keeps the full text.
 */
export function friendlyIngestError(message: string): string {
  const m = /^yt-dlp failed \(exit \d+\): ([\s\S]*)$/.exec(message);
  if (!m) return message;
  const lines = m[1]!.split(/ \| |\n/).map((l) => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => l.includes('ERROR:')) ?? lines.at(-1) ?? 'yt-dlp failed.';
  const cut = errorLine.slice(Math.max(0, errorLine.indexOf('ERROR:')));
  const final = /[.!?]$/.test(cut) ? cut : `${cut}.`;
  const hint = /\b429\b|too many requests|rate.?limit/i.test(message) ? YT_RATE_LIMIT_HINT : YT_OTHER_HINT;
  return `${final} ${hint}`;
}

/** "No replay fixture ..." grade failures: expected offline, summarized once instead of per claim. */
function isReplayMiss(message: string): boolean {
  return /No replay fixture/.test(message);
}

/** The one line an offline ingest shows for predictions it could not grade. */
export function replayMissSummary(n: number): string {
  return `${plural(n, 'prediction')} not graded offline: there is no recorded grading for ${n === 1 ? 'it' : 'them'}. Add OPENAI_API_KEY and run "receipts grade" to grade ${n === 1 ? 'it' : 'them'} live.`;
}

function optionalString(body: Record<string, unknown>, key: string, max: number): string | undefined | Error {
  const v = body[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return new Error(`"${key}" must be text.`);
  const s = v.trim();
  if (s.length > max) return new Error(`"${key}" is too long (at most ${max} characters).`);
  return s || undefined;
}

/** Validate a POST /api/ingest body. Errors are phrased for the person filling in the form. */
export function parseIngestRequest(body: unknown): { ok: true; value: IngestRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Send a JSON object: {"input": "<URL or file path>", "speaker": "<name>"}.' };
  }
  const b = body as Record<string, unknown>;
  const fields = {
    input: optionalString(b, 'input', MAX_INPUT),
    speaker: optionalString(b, 'speaker', MAX_NAME),
    host: optionalString(b, 'host', MAX_NAME),
    title: optionalString(b, 'title', MAX_TITLE),
    date: optionalString(b, 'date', 10),
    url: optionalString(b, 'url', MAX_INPUT),
    kind: optionalString(b, 'kind', 20),
  };
  for (const v of Object.values(fields)) if (v instanceof Error) return { ok: false, error: v.message };
  const f = fields as Record<keyof typeof fields, string | undefined>;
  if (!f.input) return { ok: false, error: 'Add an episode: a YouTube or web URL, or the path to a transcript or audio file.' };
  if (!f.speaker) return { ok: false, error: 'Add the speaker: the person whose claims should be extracted.' };
  if (f.date && !DATE_RE.test(f.date)) return { ok: false, error: `The date must look like 2024-05-31 (got "${f.date}").` };
  if (f.url && !isHttpUrl(f.url)) return { ok: false, error: 'The source link must start with http:// or https://.' };
  const linkProblem = sourceLinkProblem(f.input, f.url);
  if (linkProblem) return { ok: false, error: linkProblem };
  if (f.kind && !(SOURCE_KINDS as readonly string[]).includes(f.kind)) {
    return { ok: false, error: `Unknown source kind "${f.kind}". Use one of: ${SOURCE_KINDS.join(', ')}.` };
  }
  const value: IngestRequest = { input: f.input, speaker: f.speaker };
  if (f.host) value.host = f.host;
  if (f.title) value.title = f.title;
  if (f.date) value.date = f.date;
  if (f.url) value.url = f.url;
  if (f.kind) value.kind = f.kind as SourceKind;
  return { ok: true, value };
}

/**
 * Every receipt links its source, so a local file needs the episode's public
 * link: without one the receipt would point at a path on this machine.
 */
export function sourceLinkProblem(input: string, url: string | undefined): string | null {
  if (isHttpUrl(input) || url) return null;
  return 'A local file needs its source link: add the episode\'s http(s) URL so every receipt links to where it was said.';
}

/**
 * Why the web form may not read this local path, or null. Browsers can reach
 * this server, so it only reads transcript and audio files, and nothing in a
 * hidden folder (~/.ssh, .git, .env).
 */
export function localInputProblem(input: string): string | null {
  if (isHttpUrl(input)) return null;
  const ext = extname(input).toLowerCase();
  if (![...TRANSCRIPT_EXTENSIONS, ...AUDIO_EXTENSIONS].includes(ext)) {
    return `The web form reads transcript (${TRANSCRIPT_EXTENSIONS.join(' ')}) and audio files only. Use the CLI for anything else.`;
  }
  if (input.split(/[\\/]/).some((part) => part.startsWith('.') && part !== '.' && part !== '..')) {
    return 'The web form does not read files in hidden folders. Use the CLI for those.';
  }
  return null;
}

/** SourceRef for an ingest: explicit fields win, then what the transcript knows, then fallbacks. */
export function sourceFor(t: Transcript, req: IngestRequest, today: string): SourceRef {
  const url = req.url ?? t.meta.url ?? (isHttpUrl(req.input) ? req.input : undefined);
  if (!url) throw new Error(sourceLinkProblem(req.input, undefined)!);
  return {
    title: req.title ?? t.meta.title ?? basename(req.input),
    url,
    date: req.date ?? t.meta.date ?? today,
    kind: req.kind ?? t.meta.kind ?? 'podcast',
  };
}

/**
 * Whether a Host header names this server: loopback on its own port, or the
 * hostname it was bound to. Anything else is a DNS-rebinding page.
 */
export function allowedHost(host: string | null, port: number, hostname: string): boolean {
  if (!host) return false;
  const bound = hostname.includes(':') ? `[${hostname}]` : hostname;
  return ['127.0.0.1', 'localhost', '[::1]', bound].some((name) => host.toLowerCase() === `${name}:${port}`);
}

/** A request another site's page made (CSRF): a foreign Origin, or Fetch Metadata that says so. */
export function crossSite(req: Request, host: string): boolean {
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== `http://${host}`) return true;
  const site = req.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin' && site !== 'none';
}

// ---- Ingest pipeline ---------------------------------------------------------------

type Send = (e: IngestEvent) => void;

interface IngestContext {
  req: IngestRequest;
  cfg: Config;
  deps: ServerDeps;
  send: Send;
  llm: LLM;
  personSlug: string;
  /** Ids of the claims extracted from this episode. */
  ids: Set<string>;
  /** Server console only: full detail that the page gets in summarized form. */
  log: (line: string) => void;
}

/** Merge this ingest's change into the ledger file as it is now (another process may have saved meanwhile). */
function save(ctx: IngestContext, change: (l: Ledger) => Ledger | void): Ledger {
  return updateLedger(ctx.cfg.ledgerPath, change);
}

async function gradeStage(ctx: IngestContext, ledger: Ledger): Promise<Ledger> {
  const mine: Ledger = { ...ledger, claims: ledger.claims.filter((c) => ctx.ids.has(c.id)) };
  const due = dueClaims(mine, ctx.cfg.today);
  if (!due.length) {
    ctx.send({ stage: 'grade', message: 'No new prediction is past its deadline yet, so nothing to grade today.' });
    return ledger;
  }
  ctx.send({ stage: 'grade', message: `Grading ${plural(due.length, 'prediction')} whose deadline has passed. Each is checked against web evidence.` });
  let misses = 0;
  const graded = await ctx.deps.gradeDue(mine, ctx.llm, {
    today: ctx.cfg.today,
    onProgress: (e) => {
      if (e.grading) return;
      if (isReplayMiss(e.message)) {
        misses++;
        ctx.log(`grade ${e.claimId}: ${e.message}`);
        return;
      }
      // Replay answers at once, and each verdict arrives as its own line naming the claim.
      if (ctx.cfg.llmMode === 'replay' && e.message.startsWith('Grading: ')) return;
      ctx.send({ stage: 'grade', message: e.message });
    },
  });
  if (misses) ctx.send({ stage: 'grade', message: replayMissSummary(misses) });
  const next = save(ctx, (l) => patchClaims(l, graded, ['verdict', 'grading']));
  for (const c of graded) {
    ctx.send({ stage: 'graded', message: `${VERDICT_LABEL[c.verdict]}: ${c.claim}`, claim: c, html: renderReceipt(c, { animate: 'stamp' }) });
  }
  return next;
}

async function driftStage(ctx: IngestContext, ledger: Ledger): Promise<Ledger> {
  // Only the chains this episode touched: same person, same topics.
  const topics = new Set(ledger.claims.filter((c) => ctx.ids.has(c.id)).map((c) => c.topic));
  const touched: Ledger = { ...ledger, claims: claimsFor(ledger, ctx.personSlug).filter((c) => topics.has(c.topic)) };
  const labels = await ctx.deps.refineDrift(touched, ctx.llm, {
    personSlug: ctx.personSlug,
    // Seed chains keep their curated labels in a live run too (offline, the model already is the replay).
    curated: ctx.cfg.llmMode === 'replay' ? ctx.llm : new ReplayLLM(ctx.cfg.fixturesDir),
    onWarning: (m) => ctx.send({ stage: 'warning', message: m }),
  });
  const next = save(ctx, (l) => applyDrift(l, labels));
  const moves = [...ctx.ids].map((id) => labels.get(id)).filter((d) => d && NOTABLE_DRIFT.has(d.label));
  ctx.send({
    stage: 'drift',
    message: moves.length
      ? `Story drift: ${moves.map((d) => d!.note).join(' ')}`
      : 'No deadline or goalpost changes against earlier claims on these topics.',
  });
  return next;
}

// GBrain runs one process per row (seconds each), so it streams one status
// line that the page updates in place, after the ingest is already 'complete'.
async function syncStage(ctx: IngestContext, ledger: Ledger): Promise<Ledger> {
  const status = (message: string) => ctx.send({ stage: 'sync', message });
  const gb = ctx.deps.gbrain(ctx.cfg, (line) => status(`GBrain: ${line}`));
  if (!gb || !(await gb.available())) {
    status('GBrain CLI not found, so person pages were not updated. Everything is in the ledger; run "receipts sync" later.');
    return ledger;
  }
  let steps = 0;
  status(`Writing people/${ctx.personSlug} to GBrain…`);
  // syncClaims records take rows on `ledger`'s claims as it goes; merge them even on failure so a retry adds no duplicates.
  const keepRows = (from: Ledger) => save(ctx, (l) => patchClaims(l, claimsFor(from, ctx.personSlug), ['gbrain']));
  try {
    const synced = await gb.syncClaims(ledger, { personSlug: ctx.personSlug, onProgress: (m) => status(`Writing to GBrain (${++steps}): ${m}`) });
    const next = keepRows(synced);
    status(`GBrain page people/${ctx.personSlug} is up to date.`);
    return next;
  } catch (err) {
    keepRows(ledger);
    ctx.log(`GBrain sync failed (full): ${plainError(err)}`);
    ctx.send({ stage: 'warning', message: `GBrain sync failed: ${shorten(plainError(err), 400)} The ledger is saved; once the cause is fixed, "receipts sync" writes only what is missing.` });
    return ledger;
  }
}

/** Re-send cards whose final state differs from what the page last received. */
function sendFinalCards(ctx: IngestContext, ledger: Ledger, sent: Map<string, string>): void {
  for (const c of ledger.claims) {
    if (!ctx.ids.has(c.id)) continue;
    const json = JSON.stringify(c);
    if (sent.get(c.id) === json) continue;
    sent.set(c.id, json);
    ctx.send({ stage: 'updated', message: '', claim: c, html: renderReceipt(c) });
  }
}

function completeMessage(req: IngestRequest, added: number, extracted: number): string {
  if (extracted === 0) return `No checkable claims by ${req.speaker} were found in this source.`;
  const fresh = added === extracted ? plural(added, 'new receipt') : `${plural(extracted, 'receipt')} (${added} new)`;
  return `Done: ${fresh} for ${req.speaker}.`;
}

/**
 * Run one ingest, reporting through `send`. Never throws: a failure becomes an
 * 'error' event, and every stage already finished stays saved in the ledger.
 */
export async function runIngest(req: IngestRequest, cfg: Config, deps: ServerDeps, send: Send, log: (line: string) => void = () => {}): Promise<void> {
  const personSlug = slugify(req.speaker);
  const sent = new Map<string, string>();
  const track: Send = (e) => {
    if (e.claim) sent.set(e.claim.id, JSON.stringify(e.claim));
    send(e);
  };
  try {
    if (!personSlug) throw new Error('The speaker name needs at least one letter or digit.');
    const llm = deps.getLLM(cfg);
    send({ stage: 'load', message: `Loading ${req.input}` });
    const t = await deps.loadTranscript(req.input, { title: req.title, date: req.date, url: req.url, kind: req.kind, openaiKey: cfg.openaiKey });
    const source = sourceFor(t, req, cfg.today);
    if (!req.date && !t.meta.date) {
      send({ stage: 'warning', message: `No date given or found in the source, so ${cfg.today} (today) is used as the date said.` });
    }
    send({ stage: 'load', message: `Loaded “${source.title}”: ${plural(t.segments.length, 'segment')}, said ${source.date}.` });
    if (cfg.llmMode === 'replay') send({ stage: 'load', message: 'Replay mode: the model answers come from recorded fixtures, so receipts arrive within seconds.' });

    const extracted = await deps.extractClaims(t, llm, {
      speaker: req.speaker,
      speakerSlug: personSlug,
      host: req.host,
      source,
      existingTopics: topicsForSpeaker(loadLedger(cfg.ledgerPath), personSlug, source.url),
      onProgress: (e) => track(e.claim ? { ...e, html: renderReceipt(e.claim, { animate: 'card' }) } : e),
    });
    let added: Claim[] = [];
    const ledger = updateLedger(cfg.ledgerPath, (l) => {
      added = upsertClaims(l, extracted.claims).added;
    });
    send({
      stage: 'saved',
      message: `Saved ${plural(added.length, 'new claim')} to the ledger; ${plural(extracted.dropped.length, 'claim')} dropped (reasons above).`,
      count: added.length,
    });

    const ctx: IngestContext = { req, cfg, deps, send: track, llm, personSlug, ids: new Set(extracted.claims.map((c) => c.id)), log };
    let final = ledger;
    if (ctx.ids.size > 0) {
      final = await gradeStage(ctx, final);
      final = await driftStage(ctx, final);
      sendFinalCards(ctx, final, sent);
    }
    // 'complete' before GBrain: the receipts, grades and drift are saved, so the page can refresh now.
    send({
      stage: 'complete',
      message: completeMessage(req, added.length, extracted.claims.length),
      count: added.length,
      href: `/p/${encodeURIComponent(personSlug)}`,
    });
    if (ctx.ids.size > 0) sendFinalCards(ctx, await syncStage(ctx, final), sent);
  } catch (err) {
    const full = plainError(err);
    const shown = friendlyIngestError(full);
    if (shown !== full) log(`ingest error (full): ${full}`);
    send({ stage: 'error', message: shown });
  }
}

// ---- HTTP plumbing ------------------------------------------------------------------

const encoder = new TextEncoder();

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function htmlResponse(body: string, nonce: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': contentSecurityPolicy(nonce),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra },
  });
}

function methodNotAllowed(allow: string): Response {
  return jsonResponse({ error: `Use ${allow} for this address.` }, 405, { allow });
}

/**
 * An SSE response fed by `run`. A closed tab cancels the stream; writes after
 * that are dropped, and `run` keeps going so the ledger still gets saved.
 */
function sseResponse(signal: AbortSignal, heartbeatMs: number, run: (send: Send) => Promise<void>, onClose: () => void): Response {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const write = (text: string) => {
    if (!open) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      open = false;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      if (open) onClose();
      open = false;
    },
  });
  signal.addEventListener('abort', () => {
    if (open) onClose();
    open = false;
  });
  write(': receipts ingest stream\n\n');
  const beat = setInterval(() => write(': keep-alive\n\n'), heartbeatMs);
  void run((e) => write(`data: ${JSON.stringify(e)}\n\n`)).finally(() => {
    clearInterval(beat);
    if (!open) return;
    open = false;
    try {
      controller.close();
    } catch {
      // already closed by the client
    }
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
}

function tryGetLLM(cfg: Config, deps: ServerDeps): LLM | null {
  try {
    return deps.getLLM(cfg);
  } catch {
    return null;
  }
}

// ---- Server ---------------------------------------------------------------------------

export function startServer(cfg: Config, opts: ServerOptions): RunningServer {
  const deps: ServerDeps = { ...defaultDeps(), ...opts.deps };
  const log = opts.log ?? ((line: string) => console.log(line));
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const hostname = opts.hostname ?? '127.0.0.1';
  let busy = false;

  function readLedger(): Ledger {
    return withDetectedDrift(loadLedger(cfg.ledgerPath));
  }

  const mode = appMode(cfg);
  const discovering = new Set<string>();
  const wlPath = watchlistPath(cfg.ledgerPath);
  const discPath = discoveriesPath(cfg.ledgerPath);

  function readWatchlist(): Watchlist {
    try {
      return loadWatchlist(wlPath);
    } catch (err) {
      log(`watchlist unreadable: ${plainError(err)}`);
      return { version: 1, people: [] };
    }
  }

  function readDiscoveries() {
    try {
      return loadDiscoveries(discPath);
    } catch (err) {
      log(`discoveries unreadable: ${plainError(err)}`);
      return { version: 1 as const, bySlug: {} };
    }
  }

  function personCard(l: Ledger, slug: string, fallbackName: string): PersonCardData {
    const w = readWatchlist().people.find((p) => p.slug === slug);
    return cardData(l, slug, { name: claimsFor(l, slug)[0]?.person ?? w?.name ?? fallbackName, followed: !!w, lastCheckedAt: w?.lastCheckedAt, discoveries: readDiscoveries().bySlug[slug] });
  }

  function starterChips(l: Ledger, w: Watchlist): string[] {
    const chips: string[] = [];
    if (!w.people.length) chips.push('follow Jensen Huang');
    if (mode !== 'live') {
      const recorded = recordedQuestions(recordedExcerpts(cfg.fixturesDir, 'ask_answer_v2'))[0];
      if (recorded) chips.push(recorded);
    } else {
      const moved = l.claims
        .filter((c) => c.drift && NOTABLE_DRIFT.has(c.drift.label))
        .sort((a, b) => b.saidDate.localeCompare(a.saidDate))[0];
      if (moved) chips.push(`Has ${possessiveName(moved.person)} story on ${topicLabel(moved.topic)} changed?`);
    }
    const graded = new Map<string, number>();
    for (const c of l.claims) if (c.verdict === 'correct' || c.verdict === 'incorrect' || c.verdict === 'partial') graded.set(c.topic, (graded.get(c.topic) ?? 0) + 1);
    const top = [...graded.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (top) chips.push(`Who has been most wrong about ${topicLabel(top[0])}?`);
    chips.push("What's coming due before the end of the year?");
    return [...new Set(chips)].slice(0, 4);
  }

  function page(req: Request, path: string): Response {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET');
    const nonce = newNonce();
    const l = readLedger();
    if (path === '/' || path === '/index.html') {
      const w = readWatchlist();
      const d = readDiscoveries();
      const people = peopleData(l, w, d);
      const html = renderDashboard(
        { today: cfg.today, ...people, feed: buildFeed(l, d, w, cfg.today), chips: starterChips(l, w), emptyLedger: l.claims.length === 0 },
        { nonce, mode },
      );
      return htmlResponse(html, nonce);
    }
    if (path === '/classic' || path === '/classic/') {
      const questions = recordedQuestions(recordedExcerpts(cfg.fixturesDir, 'ask_answer'));
      return htmlResponse(renderIndex(l, scoreAll(l), { live: true, nonce, questions }), nonce);
    }
    let slug: string;
    try {
      slug = decodeURIComponent(path.slice('/p/'.length).replace(/\/+$/, ''));
    } catch {
      return htmlResponse(renderNotFound('That address is not a valid person link.', { live: true }), nonce, 404);
    }
    const followed = readWatchlist().people.find((p) => p.slug === slug);
    if (!claimsFor(l, slug).length && !followed) return htmlResponse(renderNotFound(`No receipts on file for “${slug}”.`, { live: true }), nonce, 404);
    const followInfo = followed ? { name: followed.name, ...(followed.lastCheckedAt ? { lastCheckedAt: followed.lastCheckedAt } : {}) } : undefined;
    return htmlResponse(renderPersonV2(l, slug, { nonce, mode, followed: followInfo, discoveries: readDiscoveries().bySlug[slug] }), nonce);
  }

  /** POST body as a JSON object, or the error response to return. */
  async function jsonBody(req: Request): Promise<Record<string, unknown> | Response> {
    if (req.method !== 'POST') return methodNotAllowed('POST');
    if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) return jsonResponse({ error: 'Send the request as application/json.' }, 415);
    try {
      const b = (await req.json()) as unknown;
      if (!b || typeof b !== 'object' || Array.isArray(b)) return jsonResponse({ error: 'Send a JSON object.' }, 400);
      return b as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: 'Send a JSON object.' }, 400);
    }
  }

  function text(b: Record<string, unknown>, key: string, max: number): string | undefined {
    const v = b[key];
    if (typeof v !== 'string') return undefined;
    const t = v.replace(/\s+/g, ' ').trim();
    return t && t.length <= max ? t : undefined;
  }

  async function inputRoute(req: Request): Promise<Response> {
    const b = await jsonBody(req);
    if (b instanceof Response) return b;
    const t = text(b, 'text', MAX_QUESTION);
    if (!t) return jsonResponse({ error: `Type a name, a link or a question (under ${MAX_QUESTION} characters).` }, 400);
    const l = loadLedger(cfg.ledgerPath);
    const llm = mode === 'live' ? tryGetLLM(cfg, deps) : null;
    let route;
    try {
      route = await deps.routeInput(t, knownPeople(l, readWatchlist()), { llm, ledger: l });
    } catch (err) {
      log(`route failed: ${plainError(err)}`);
      route = await deps.routeInput(t, knownPeople(l, readWatchlist()), { llm: null, ledger: l });
    }
    if (route.kind === 'pull' && !route.speaker && route.url && /^https?:\/\//i.test(route.url)) {
      // Suggest the speaker from the video title ("Extended interview: Dario Amodei").
      const known = knownPeople(l, readWatchlist());
      const title = mode === 'live' && isYouTubeUrl(route.url) ? await youtubeTitle(route.url) : null;
      const found = title ? resolvePeople(title, known) : null;
      const suggest = [...new Set([...(found?.slugs ?? []).flatMap((s) => known.find((p) => p.slug === s)?.name ?? []), ...(found?.unknownNames ?? [])])].slice(0, 3);
      return jsonResponse({ route: { ...route, ...(title ? { title } : {}), suggest } });
    }
    return jsonResponse({ route });
  }

  async function youtubeTitle(url: string): Promise<string | null> {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const j = (await res.json()) as { title?: unknown };
      return typeof j.title === 'string' ? j.title.slice(0, 200) : null;
    } catch {
      return null;
    }
  }

  async function followRoute(req: Request): Promise<Response> {
    const b = await jsonBody(req);
    if (b instanceof Response) return b;
    const name = text(b, 'name', MAX_NAME);
    if (!name || !slugify(name)) return jsonResponse({ error: 'Type the person\'s name, for example: follow Jensen Huang.' }, 400);
    const l = loadLedger(cfg.ledgerPath);
    // Follow by the name on record when the slug is already known ("jensen huang" -> "Jensen Huang").
    const onRecord = claimsFor(l, slugify(name))[0]?.person;
    const { person, created } = follow(wlPath, onRecord ?? name);
    const card = personCard(withDetectedDrift(l), person.slug, person.name);
    log(`follow: ${person.name}${created ? '' : ' (already followed)'}`);
    return jsonResponse({ person, created, card, html: renderPersonCardHtml(card) });
  }

  async function unfollowRoute(req: Request): Promise<Response> {
    const b = await jsonBody(req);
    if (b instanceof Response) return b;
    const name = text(b, 'name', MAX_NAME);
    if (!name) return jsonResponse({ error: 'Say who to stop following.' }, 400);
    return jsonResponse({ ok: unfollow(wlPath, name) });
  }

  function discoverError(err: unknown, name: string): string {
    if (err instanceof ReplayMissError || (mode !== 'live' && err instanceof LLMUnavailableError)) {
      return `Live search is off (${mode === 'replay' ? 'offline replay' : 'no API key'}), and there is no recording of a search for ${name}. Add OPENAI_API_KEY and restart with receipts start.`;
    }
    if (err instanceof LLMUnavailableError) return 'Could not reach the web search right now. Check the internet connection and try again.';
    return 'The search did not work this time. Try again in a minute.';
  }

  async function discoverRoute(req: Request): Promise<Response> {
    const b = await jsonBody(req);
    if (b instanceof Response) return b;
    const l = loadLedger(cfg.ledgerPath);
    const slugIn = text(b, 'slug', MAX_NAME);
    let name = text(b, 'name', MAX_NAME);
    if (!name && slugIn) name = findFollowed(wlPath, slugIn)?.name ?? claimsFor(l, slugIn)[0]?.person;
    if (!name || !slugify(name)) return jsonResponse({ error: 'Say whose appearances to look for.' }, 400);
    const slug = slugIn && slugify(slugIn) === slugIn ? slugIn : slugify(name);
    const onRecord = claimsFor(l, slug)[0]?.person;
    const limitRaw = typeof b.limit === 'number' ? Math.floor(b.limit) : undefined;
    const force = b.force === true;
    const stored = b.stored === true;
    if (discovering.has(slug)) return jsonResponse({ error: `Already searching for ${name}. Wait for it to finish.` }, 409);
    // Discovering someone follows them.
    const person = findFollowed(wlPath, slug) ?? follow(wlPath, onRecord ?? name).person;
    const prev = readDiscoveries().bySlug[slug];
    const last = person.lastCheckedAt ?? prev?.checkedAt;
    const recent = !!prev && !!last && Date.now() - Date.parse(last) < 10 * 60_000;
    discovering.add(slug);
    log(`discover: ${person.name}${stored || (recent && !force) ? ' (stored)' : ''}`);
    return sseResponse(
      req.signal,
      heartbeatMs,
      async (send) => {
        const out = (e: Record<string, unknown>) => send(e as unknown as IngestEvent);
        try {
          if (prev && (stored || (recent && !force))) {
            out({ stage: 'note', message: `Checked ${relativeTime(prev.checkedAt)}. Showing what was found then.` });
            out({ stage: 'panel', message: '', html: renderDiscoveries(person.name, slug, prev) });
            out({ stage: 'complete', message: 'Pick one to pull receipts from, or search again.' });
            return;
          }
          const llm = deps.getLLM(cfg);
          let complete = 'Done. Pick one to pull receipts from.';
          const result = await deps.discoverAppearances(person.name, llm, {
            today: cfg.today,
            ledger: l,
            ...(limitRaw ? { limit: limitRaw } : {}),
            checkLinks: mode === 'live' ? (url: string, init?: RequestInit) => fetch(url, init) : undefined,
            onProgress: (e) => {
              if (e.stage === 'candidate' && e.candidate) out({ ...e, html: renderCandidateRow(e.candidate, slug) });
              else if (e.stage === 'complete') complete = e.message;
              else out({ ...e });
            },
          });
          const haveKeys = new Set(result.have.map((c) => sourceKey(c.url) ?? c.url));
          const record = recordDiscovery(discPath, slug, { since: result.since, candidates: [...result.candidates, ...result.have], have: haveKeys });
          markChecked(wlPath, slug);
          out({ stage: 'panel', message: '', html: renderDiscoveries(person.name, slug, record) });
          const card = personCard(withDetectedDrift(loadLedger(cfg.ledgerPath)), slug, person.name);
          out({ stage: 'card', message: '', slug, html: renderPersonCardHtml(card) });
          if (result.model.startsWith('replay:') && mode === 'live') out({ stage: 'note', message: 'The network was unavailable, so this came from a recording.' });
          out({ stage: 'complete', message: result.candidates.length ? complete : `No new long-form appearances found since ${result.since}.` });
        } catch (err) {
          log(`discover ${person.name} failed: ${plainError(err)}`);
          out({ stage: 'error', message: discoverError(err, person.name) });
        } finally {
          discovering.delete(slug);
        }
      },
      () => log('discover: browser disconnected; finishing in the background'),
    );
  }

  async function pullRoute(req: Request): Promise<Response> {
    const b = await jsonBody(req);
    if (b instanceof Response) return b;
    const url = text(b, 'url', MAX_INPUT);
    if (!url) return jsonResponse({ error: 'Paste the link to pull receipts from.' }, 400);
    const mm = typeof b.maxMinutes === 'number' && b.maxMinutes > 0 ? Math.min(600, Math.floor(b.maxMinutes)) : undefined;
    const slugIn = text(b, 'slug', MAX_NAME);
    let candidate: Candidate | undefined;
    let person: { name: string; slug: string };
    if (slugIn) {
      candidate = findCandidate(discPath, slugIn, url);
      if (!candidate) return jsonResponse({ error: 'That appearance is no longer in the list. Search again.' }, 404);
      const l = loadLedger(cfg.ledgerPath);
      person = { name: claimsFor(l, slugIn)[0]?.person ?? findFollowed(wlPath, slugIn)?.name ?? slugIn, slug: slugIn };
    } else {
      const speaker = text(b, 'speaker', MAX_NAME);
      if (!speaker || !slugify(speaker)) return jsonResponse({ error: 'Whose words should I pull from this? Add the speaker\'s name.' }, 400);
      if (!isHttpUrl(url)) return jsonResponse({ error: 'For a file on this computer, use "Pull an episode with details" under Advanced.' }, 400);
      if (!isPublicHttpUrl(url)) return jsonResponse({ error: 'That link is not a public web address, so it cannot be pulled.' }, 400);
      const date = text(b, 'date', 10);
      if (date && !DATE_RE.test(date)) return jsonResponse({ error: `The date must look like 2024-05-31 (got "${date}").` }, 400);
      const kindIn = text(b, 'kind', 20);
      const src = transcriptSourceOf(url, 'page');
      const l = loadLedger(cfg.ledgerPath);
      const onRecord = claimsFor(l, slugify(speaker))[0]?.person;
      person = { name: onRecord ?? speaker, slug: slugify(speaker) };
      candidate = {
        title: text(b, 'title', MAX_TITLE) ?? '',
        show: '',
        date: date ?? '',
        url,
        kind: kindIn && (SOURCE_KINDS as readonly string[]).includes(kindIn) ? (kindIn as SourceKind) : src === 'youtube' ? 'interview' : 'article',
        transcriptSource: src,
        why: '',
        linkConfirmed: true,
      };
      const host = text(b, 'host', MAX_NAME);
      if (host) candidate.host = host;
    }
    if (busy) return jsonResponse({ error: 'Another episode is being pulled. Wait for it to finish, then try again.' }, 409);
    busy = true;
    const c = candidate;
    const who = person;
    log(`pull: ${c.url} (speaker ${who.name}${mm ? `, first ${mm} min` : ''})`);
    return sseResponse(
      req.signal,
      heartbeatMs,
      async (send) => {
        try {
          await deps.pullCandidate(c, who, {
            cfg,
            deps,
            run: runIngest,
            maxMinutes: mm,
            log,
            send: humanPullEvents((e) => {
              if (e.stage === 'error' || e.stage === 'complete') log(`pull ${e.stage}: ${e.message}`);
              send(e);
            }, who.name),
          });
        } catch (err) {
          log(`pull failed: ${plainError(err)}`);
          send({ stage: 'error', message: friendlyPullError(plainError(err)) });
        } finally {
          busy = false;
        }
      },
      () => log('pull: browser disconnected; finishing in the background'),
    );
  }

  async function askPostRoute(req: Request): Promise<Response> {
    const b = await jsonBody(req);
    if (b instanceof Response) return b;
    const q = text(b, 'q', MAX_QUESTION);
    if (!q) return jsonResponse({ error: `Ask a question in plain words (under ${MAX_QUESTION} characters).` }, 400);
    const personSlug = text(b, 'personSlug', MAX_NAME);
    const l = loadLedger(cfg.ledgerPath);
    const watchlist = readWatchlist();
    const llm = tryGetLLM(cfg, deps);
    let note: string | undefined;
    let result;
    try {
      result = await deps.answerQuestion(q, l, { llm, today: cfg.today, watchlist, ...(personSlug ? { personSlug } : {}) });
    } catch (err) {
      log(`ask failed, answering from the receipts alone: ${plainError(err)}`);
      note = 'The model could not be reached, so this answer comes from the receipts alone.';
      result = await deps.answerQuestion(q, l, { llm: null, today: cfg.today, watchlist, ...(personSlug ? { personSlug } : {}) });
    }
    // On a person's own page, "Open X's page" goes nowhere.
    if (personSlug) result = { ...result, actions: result.actions.filter((a) => !(a.type === 'open' && a.slug === personSlug)) };
    if (result.fromRecording) note = mode === 'live' ? 'The network was unavailable, so this came from a recording.' : 'Replayed from a recording (offline mode).';
    return jsonResponse({ ...result, note: [result.note, note].filter(Boolean).join(' ') || undefined, html: renderAnswerCard(result, note) });
  }

  function statusRoute(req: Request): Response {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    const l = loadLedger(cfg.ledgerPath);
    return jsonResponse({
      mode,
      today: cfg.today,
      people: new Set(l.claims.map((c) => c.personSlug)).size,
      claims: l.claims.length,
      followed: readWatchlist().people.length,
      gbrain: Bun.which(cfg.gbrainBin) !== null,
    });
  }

  function watchlistRoute(req: Request): Response {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    const l = readLedger();
    return jsonResponse({ people: peopleData(l, readWatchlist(), readDiscoveries()).cards });
  }

  function feedRoute(req: Request): Response {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    return jsonResponse({ items: buildFeed(readLedger(), readDiscoveries(), readWatchlist(), cfg.today) });
  }

  async function askRoute(req: Request, url: URL): Promise<Response> {
    if (req.method === 'POST') return askPostRoute(req);
    if (req.method !== 'GET') return methodNotAllowed('GET');
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q) return jsonResponse({ error: `Ask a question, for example: "${EXAMPLE_QUESTION}"` }, 400);
    if (q.length > MAX_QUESTION) return jsonResponse({ error: `Keep the question under ${MAX_QUESTION} characters.` }, 400);
    const l = loadLedger(cfg.ledgerPath);
    const llm = tryGetLLM(cfg, deps);
    let note: string | undefined;
    let result;
    try {
      result = await deps.ask(q, l, llm);
    } catch (err) {
      if (!llm) throw err;
      note = `The model could not be reached (${plainError(err)}), so this answer comes from the ledger alone.`;
      result = await deps.ask(q, l, null);
    }
    return jsonResponse({
      // Some model answers come back with JSON-escaped quotes (\"); show plain quotes.
      answer: result.answer.replace(/\\"/g, '"'),
      people: result.people,
      usedModel: result.usedModel,
      note: [note, result.note].filter(Boolean).join(' ') || undefined,
      receipts: result.receipts.map((c) => ({ id: c.id, person: c.person, personSlug: c.personSlug, saidDate: c.saidDate, quote: c.quote, claim: c.claim, verdict: c.verdict })),
      html: renderAskReceipts(result.receipts),
    });
  }

  async function ingestRoute(req: Request): Promise<Response> {
    if (req.method !== 'POST') return methodNotAllowed('POST');
    // A JSON content type forces a CORS preflight, which this server never answers.
    if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) {
      return jsonResponse({ error: 'Send the ingest request as application/json.' }, 415);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'Send JSON: {"input": "<URL or file path>", "speaker": "<name>"}.' }, 400);
    }
    const parsed = parseIngestRequest(body);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);
    const localProblem = localInputProblem(parsed.value.input);
    if (localProblem) return jsonResponse({ error: localProblem }, 400);
    // Checked after the last await so two requests cannot both get through.
    if (busy) return jsonResponse({ error: 'Another episode is being ingested. Wait for it to finish, then try again.' }, 409);
    busy = true;
    const ingest = parsed.value;
    log(`ingest: ${ingest.input} (speaker ${ingest.speaker})`);
    return sseResponse(
      req.signal,
      heartbeatMs,
      async (send) => {
        try {
          await runIngest(
            ingest,
            cfg,
            deps,
            (e) => {
              if (e.stage === 'error' || e.stage === 'complete') log(`ingest ${e.stage}: ${e.message}`);
              send(e);
            },
            log,
          );
        } finally {
          busy = false;
        }
      },
      () => log('ingest: browser disconnected; finishing in the background'),
    );
  }

  async function route(req: Request, server: Server): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const host = req.headers.get('host');
    if (!allowedHost(host, boundPort, hostname)) {
      return jsonResponse({ error: `Open Receipts at http://127.0.0.1:${boundPort}/ (this host name is not served).` }, 421);
    }
    if (path.startsWith('/api/') && crossSite(req, host!)) return jsonResponse({ error: 'Requests from other sites are not accepted.' }, 403);
    // A live model call (web search, retries) can outlast the idle timeout; ingest streams heartbeats but may wait on one too.
    if (['/api/ask', '/api/ingest', '/api/discover', '/api/pull', '/api/input'].includes(path)) server.timeout(req, 0);
    try {
      if (path === '/' || path === '/index.html' || path === '/classic' || path === '/classic/' || path.startsWith('/p/')) return page(req, path);
      if (path === '/api/status') return statusRoute(req);
      if (path === '/api/watchlist') return watchlistRoute(req);
      if (path === '/api/feed') return feedRoute(req);
      if (path === '/api/input') return await inputRoute(req);
      if (path === '/api/follow') return await followRoute(req);
      if (path === '/api/unfollow') return await unfollowRoute(req);
      if (path === '/api/discover') return await discoverRoute(req);
      if (path === '/api/pull') return await pullRoute(req);
      if (path === '/api/ledger') return req.method === 'GET' ? jsonResponse(loadLedger(cfg.ledgerPath)) : methodNotAllowed('GET');
      if (path === '/api/ask') return await askRoute(req, url);
      if (path === '/api/ingest') return await ingestRoute(req);
      if (path.startsWith('/api/')) return jsonResponse({ error: `No API route ${path}.` }, 404);
      return htmlResponse(renderNotFound(`Nothing lives at ${path}.`, { live: true }), newNonce(), 404);
    } catch (err) {
      log(`error on ${req.method} ${path}: ${plainError(err)}`);
      return jsonResponse({ error: path.startsWith('/api/') && path !== '/api/ask' && path !== '/api/ingest' ? 'Something went wrong on our side. The details are in the server console.' : plainError(err) }, 500);
    }
  }

  let boundPort = opts.port;
  const server = Bun.serve({
    port: opts.port,
    hostname,
    // SSE keeps connections open through long model calls; heartbeats keep them alive.
    idleTimeout: 120,
    fetch: route,
  });
  const port = server.port ?? opts.port;
  boundPort = port;
  return {
    url: `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`,
    port,
    stop: () => server.stop(true),
  };
}
