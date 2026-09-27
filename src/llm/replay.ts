// Offline model calls. ReplayLLM answers from fixtures/llm/<schemaName>-<key>.json;
// RecordingLLM wraps a live LLM and writes those files after each success.
// A fixture holds the request identity (hashes and a short excerpt) and the
// validated response. Nothing else: no headers, no keys, no raw API bodies.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stripSignedParamsIn } from '../url.ts';
import { LLMUnavailableError } from './provider.ts';
import type { Citation, JsonRequest, JsonResponse, LLM } from './provider.ts';

const USER_EXCERPT_CHARS = 200;
const REPLAY_PREFIX = 'replay:';

export type FixtureKeyInput = Pick<JsonRequest<unknown>, 'schemaName' | 'variant' | 'system' | 'user' | 'webSearch'>;

export interface Fixture {
  request: { schemaName: string; variant: string | null; system_sha: string; user_excerpt: string };
  response: { data: unknown; citations: Citation[]; searched?: Citation[]; model: string };
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * First 16 hex of sha256 over the call's identity. Absent variant/webSearch
 * are normalized (null/false) so `webSearch: false` and an omitted flag share
 * a fixture.
 */
export function fixtureKey(req: FixtureKeyInput): string {
  const identity = {
    schemaName: req.schemaName,
    variant: req.variant ?? null,
    system: req.system,
    user: req.user,
    webSearch: req.webSearch ?? false,
  };
  return sha256Hex(JSON.stringify(identity)).slice(0, 16);
}

export function fixtureFileName(req: FixtureKeyInput): string {
  return `${req.schemaName}-${fixtureKey(req)}.json`;
}

// Safety net: prompts never contain keys, but a pasted transcript could.
// Key-shaped means "sk-" at the start of a word, 20+ key characters and some
// uppercase (real keys are mixed case), so recorded evidence URLs such as
// ".../elon-musk-says-..." or ".../sk-hynix-results" stay intact.
const KEY_SHAPED = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_*-]{20,}/g;

function redactKeys(text: string): string {
  return text.replace(KEY_SHAPED, (m) => (/[A-Z]/.test(m) ? 'sk-REDACTED' : m));
}

function stripReplayPrefix(model: string): string {
  return model.startsWith(REPLAY_PREFIX) ? model.slice(REPLAY_PREFIX.length) : model;
}

export function buildFixture<T>(req: JsonRequest<T>, res: JsonResponse<T>): Fixture {
  return {
    request: {
      schemaName: req.schemaName,
      variant: req.variant ?? null,
      system_sha: sha256Hex(req.system).slice(0, 16),
      user_excerpt: req.user.slice(0, USER_EXCERPT_CHARS),
    },
    response: {
      data: res.data,
      citations: res.citations,
      ...(res.searched?.length ? { searched: res.searched } : {}),
      model: stripReplayPrefix(res.model),
    },
  };
}

/** Pretty JSON with a trailing newline, as written to disk. */
export function serializeFixture(f: Fixture): string {
  return `${stripSignedParamsIn(redactKeys(JSON.stringify(f, null, 2)))}\n`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readFixtureResponse(path: string): Fixture['response'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Replay fixture ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const response = isRecord(parsed) ? parsed.response : undefined;
  if (!isRecord(response) || !('data' in response)) throw new Error(`Replay fixture ${path} has no response.data`);
  const citations = Array.isArray(response.citations) ? (response.citations as Citation[]) : [];
  const searched = Array.isArray(response.searched) ? (response.searched as Citation[]) : undefined;
  const model = typeof response.model === 'string' ? response.model : 'unknown';
  return { data: response.data, citations, ...(searched ? { searched } : {}), model };
}

/**
 * No fixture for this exact prompt. The message names the fixture file (never
 * its absolute path, which would end up in the web log) and, when a
 * recording of the same kind exists, the prompt line that differs from it.
 */
export class ReplayMissError extends LLMUnavailableError {
  constructor(
    readonly schemaName: string,
    readonly fileName: string,
    readonly difference: string | null,
  ) {
    super(
      `No replay fixture for ${schemaName} (${fileName}). ` +
        (difference ? `The closest recording differs in ${difference}. ` : '') +
        'Use exactly the speaker, host, title, date, link and --today of the recording, or record it with RECEIPTS_RECORD=1 and a live key.',
    );
    this.name = 'ReplayMissError';
  }
}

interface PromptLine {
  label: string;
  value: string;
}

// "Host (never attribute their words to the speaker): Sam Host" -> { label: "Host", value: "Sam Host" }
function promptLines(text: string): PromptLine[] {
  return text.split('\n').flatMap((line) => {
    const m = /^([A-Z][A-Za-z ]{0,30}?)(?: \([^)]*\))?: (.*)$/.exec(line);
    return m ? [{ label: m[1]!, value: m[2]! }] : [];
  });
}

function quoted(value: string | undefined): string {
  return value === undefined ? 'none' : `"${value.length > 80 ? `${value.slice(0, 79)}…` : value}"`;
}

/**
 * The first labeled prompt line ("Speaker", "Host", "Source", "Date said")
 * where `user` differs from the closest recorded excerpt, as
 * `Host: recorded "Sam Host", this request none`. Excerpts are cut at 200
 * characters, so a recorded line that is a prefix of the request's counts as
 * the same. Null when no excerpt is given; "the text after those lines" when
 * every labeled line matches.
 */
export function promptDifference(user: string, excerpts: readonly string[]): string | null {
  if (excerpts.length === 0) return null;
  const mine = promptLines(user);
  const same = (rec: PromptLine): boolean => mine.some((l) => l.label === rec.label && l.value.startsWith(rec.value));
  const ranked = excerpts
    .map((e) => promptLines(e))
    .map((lines) => ({ lines, matching: lines.filter(same).length }))
    .sort((a, b) => b.matching - a.matching);
  const best = ranked[0]!.lines;
  const recordedLabels = new Set(best.map((l) => l.label));
  const differing = best.find((rec) => !same(rec));
  if (differing) {
    const got = mine.find((l) => l.label === differing.label)?.value;
    return `${differing.label}: recorded ${quoted(differing.value)}, this request ${quoted(got)}`;
  }
  const extra = promptLines(user.slice(0, USER_EXCERPT_CHARS)).find((l) => !recordedLabels.has(l.label));
  if (extra) return `${extra.label}: recorded none, this request ${quoted(extra.value)}`;
  return 'the text after those lines (transcript, known topics or claims)';
}

/** The user-prompt excerpts of the recorded fixtures for one schema (and variant), sorted by file name. */
export function recordedExcerpts(dir: string, schemaName: string, variant: string | null = null): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${schemaName}-`) && f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      try {
        const r = (JSON.parse(readFileSync(join(dir, f), 'utf8')) as Partial<Fixture>).request;
        return r && (r.variant ?? null) === variant && typeof r.user_excerpt === 'string' ? [r.user_excerpt] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Recorded responses for one schema whose user-prompt excerpt passes `match`,
 * newest file first. Used when the exact prompt changed since recording (for
 * example new receipts entered an answer's context) to find the recording of
 * the same question.
 */
export function recordedResponses(dir: string, schemaName: string, match: (excerpt: string) => boolean): Fixture['response'][] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${schemaName}-`) && f.endsWith('.json'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t || a.f.localeCompare(b.f))
    .flatMap(({ f }) => {
      try {
        const r = (JSON.parse(readFileSync(join(dir, f), 'utf8')) as Partial<Fixture>).request;
        if (!r || typeof r.user_excerpt !== 'string' || (r.variant ?? null) !== null || !match(r.user_excerpt)) return [];
        return [readFixtureResponse(join(dir, f))];
      } catch {
        return [];
      }
    });
}

export class ReplayLLM implements LLM {
  readonly name = 'replay';

  /** `dir` holds the fixture files (Config.fixturesDir, i.e. fixtures/llm). */
  constructor(readonly dir: string) {}

  async json<T>(req: JsonRequest<T>): Promise<JsonResponse<T>> {
    const file = fixtureFileName(req);
    const path = join(this.dir, file);
    if (!existsSync(path)) {
      const kind = `${req.schemaName}${req.variant ? ` (variant ${req.variant})` : ''}`;
      throw new ReplayMissError(kind, file, promptDifference(req.user, recordedExcerpts(this.dir, req.schemaName, req.variant ?? null)));
    }
    const fixture = readFixtureResponse(path);
    const parsed = req.schema.safeParse(fixture.data);
    if (!parsed.success) throw new Error(`Replay fixture ${path} no longer matches the ${req.schemaName} schema`);
    const searched = fixture.searched?.length ? { searched: fixture.searched } : {};
    return { data: parsed.data, citations: fixture.citations, ...searched, model: `${REPLAY_PREFIX}${fixture.model}` };
  }
}

/**
 * Answers written by hand or by a script rather than by a model: the synthetic
 * test interview ("synthetic-fixture") and hand labels ("human:...").
 */
export function isHandWrittenModel(model: string): boolean {
  return model === 'synthetic-fixture' || model.startsWith('human:');
}

function isHandWrittenFixture(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return isHandWrittenModel(readFixtureResponse(path).model);
  } catch {
    return false;
  }
}

const KEEP_EXISTING = new Set(['discover_appearances']);

export class RecordingLLM implements LLM {
  readonly name: string;

  constructor(
    private readonly inner: LLM,
    readonly dir: string,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
  ) {
    this.name = inner.name;
  }

  async json<T>(req: JsonRequest<T>): Promise<JsonResponse<T>> {
    const res = await this.inner.json(req);
    const file = fixtureFileName(req);
    const path = join(this.dir, file);
    // A live answer never replaces a hand-written fixture, so recording with the same
    // prompt cannot change what the offline demo and tests replay. The scripts that
    // regenerate hand-written fixtures answer as hand-written models and still write.
    if (!isHandWrittenModel(stripReplayPrefix(res.model)) && isHandWrittenFixture(path)) {
      this.warn(`Not recorded: ${file} is a hand-written fixture and stays as it is. Record with your own episode's values.`);
      return res;
    }
    // Web-search answers differ run to run: a live discovery never replaces the
    // recording the offline demo relies on unless RECEIPTS_RECORD=force.
    if (KEEP_EXISTING.has(req.schemaName) && existsSync(path) && (process.env.RECEIPTS_RECORD ?? '').toLowerCase() !== 'force') {
      this.warn(`Not recorded: ${file} already exists (set RECEIPTS_RECORD=force to replace it).`);
      return res;
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path, serializeFixture(buildFixture(req, res)));
    return res;
  }
}
