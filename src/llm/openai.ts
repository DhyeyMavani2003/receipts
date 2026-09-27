// OpenAI Responses API client: structured JSON output validated with zod,
// optional web_search tool, retries, timeouts and model auto-selection.
// Raw fetch on purpose (only runtime dependency is zod). The API key goes in
// the Authorization header and nowhere else: never into errors or logs.

import { z } from 'zod';

import { LLMUnavailableError } from './provider.ts';
import type { Citation, JsonRequest, JsonResponse, LLM } from './provider.ts';
import { toOpenAISchema } from './schema.ts';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** First one the account can use wins. */
export const MODEL_PREFERENCE = ['gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1'] as const;
/** Used when the model list cannot be read. */
export const FALLBACK_MODEL = 'gpt-5';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_ERROR_FEEDBACK_CHARS = 1_500;

/** The slice of fetch this client uses; the global fetch satisfies it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface OpenAIOptions {
  apiKey: string;
  /** RECEIPTS_MODEL: pins the model for every role. */
  model?: string;
  /** RECEIPTS_GRADER_MODEL: pins the model for role 'grader'. */
  graderModel?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Per HTTP attempt. */
  timeoutMs?: number;
  /** HTTP attempts on 429/5xx/network errors/timeouts. */
  maxAttempts?: number;
  /** Base of the exponential backoff (doubles per attempt). */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Non-retryable API failure with a message that is safe to show. */
export class OpenAIError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

// ---- Pure helpers ------------------------------------------------------

/**
 * Scrub anything that looks like an OpenAI key from text bound for an error.
 * Only at a word start, so "elon-musk-says" in a URL is left alone.
 */
export function redactSecrets(text: string): string {
  return text.replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_*-]{8,}/g, 'sk-***');
}

export function pickModel(available: readonly string[]): string {
  const ids = new Set(available);
  return MODEL_PREFERENCE.find((m) => ids.has(m)) ?? FALLBACK_MODEL;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// Format names must match ^[a-zA-Z0-9_-]{1,64}$.
function formatName(schemaName: string): string {
  return schemaName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'output';
}

export interface ResponsesRequestBody {
  model: string;
  input: { role: 'system' | 'user'; content: string }[];
  text: { format: { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict: true } };
  tools?: { type: 'web_search' }[];
  include?: string[];
}

/** Asks the API to list every URL the web search consulted, not only the cited ones. */
export const SEARCH_SOURCES_INCLUDE = 'web_search_call.action.sources';

/**
 * Request body for POST /responses. No temperature: reasoning models reject it.
 * `withSources: false` drops the sources include for accounts that reject it.
 */
export function buildResponsesBody(
  model: string,
  req: Pick<JsonRequest<unknown>, 'schemaName' | 'schema' | 'system' | 'user' | 'webSearch'>,
  withSources = true,
): ResponsesRequestBody {
  const body: ResponsesRequestBody = {
    model,
    input: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    text: { format: { type: 'json_schema', name: formatName(req.schemaName), schema: toOpenAISchema(req.schema), strict: true } },
  };
  if (req.webSearch) {
    body.tools = [{ type: 'web_search' }];
    if (withSources) body.include = [SEARCH_SOURCES_INCLUDE];
  }
  return body;
}

export interface ParsedOutput {
  text: string;
  citations: Citation[];
  searched: Citation[];
  model?: string;
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Map<string, Citation>();
  for (const c of citations) {
    const prev = seen.get(c.url);
    if (!prev) seen.set(c.url, c);
    else if (!prev.title && c.title) seen.set(c.url, c);
  }
  return [...seen.values()];
}

function citationsOf(part: Record<string, unknown>): Citation[] {
  const out: Citation[] = [];
  for (const a of asArray(part.annotations)) {
    if (!isRecord(a) || a.type !== 'url_citation' || typeof a.url !== 'string') continue;
    out.push(typeof a.title === 'string' && a.title ? { url: a.url, title: a.title } : { url: a.url });
  }
  return out;
}

// A web_search_call item's action.sources: the pages the search actually read.
function searchSourcesOf(item: Record<string, unknown>): Citation[] {
  const action = isRecord(item.action) ? item.action : {};
  return asArray(action.sources).flatMap((s) => (isRecord(s) && typeof s.url === 'string' ? [{ url: s.url }] : []));
}

/**
 * Pull the JSON text and citations out of a Responses API body. The last
 * message item carries the answer and its url_citation annotations; earlier
 * web_search_call items list the pages the search read, kept apart in
 * `searched` because reading a page is not citing it. A top-level
 * `output_text` is the fallback.
 */
export function parseResponsesOutput(body: unknown): ParsedOutput {
  if (!isRecord(body)) throw new OpenAIError('OpenAI returned a non-object response body');
  if (isRecord(body.error) && typeof body.error.message === 'string') {
    throw new OpenAIError(`OpenAI response failed: ${redactSecrets(body.error.message)}`);
  }
  if (body.status === 'incomplete') {
    const reason = isRecord(body.incomplete_details) ? String(body.incomplete_details.reason ?? 'unknown') : 'unknown';
    throw new OpenAIError(`OpenAI response incomplete (${reason})`);
  }

  const citations: Citation[] = [];
  const searched: Citation[] = [];
  let text: string | undefined;
  for (const item of asArray(body.output)) {
    if (isRecord(item) && item.type === 'web_search_call') searched.push(...searchSourcesOf(item));
    if (!isRecord(item) || item.type !== 'message') continue;
    const parts: string[] = [];
    for (const part of asArray(item.content)) {
      if (!isRecord(part)) continue;
      if (part.type === 'refusal') throw new OpenAIError(`Model refused: ${String(part.refusal ?? '')}`.trim());
      if (part.type !== 'output_text' || typeof part.text !== 'string') continue;
      parts.push(part.text);
      citations.push(...citationsOf(part));
    }
    if (parts.length > 0) text = parts.join('');
  }
  if (text === undefined && typeof body.output_text === 'string' && body.output_text) text = body.output_text;
  if (text === undefined) throw new OpenAIError('OpenAI response had no output_text');

  const model = typeof body.model === 'string' ? body.model : undefined;
  const cited = dedupeCitations(citations);
  const citedUrls = new Set(cited.map((c) => c.url));
  return { text, citations: cited, searched: dedupeCitations(searched).filter((c) => !citedUrls.has(c.url)), model };
}

export type Validation<T> = { ok: true; data: T } | { ok: false; error: string };

/** JSON.parse + zod, with an error string suitable for feeding back to the model. */
export function validateOutput<T>(text: string, schema: z.ZodType<T>): Validation<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Reply was not valid JSON (${(e as Error).message}).` };
  }
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: z.prettifyError(result.error) };
}

export function retryPrompt(user: string, error: string): string {
  return (
    `${user}\n\n---\nYour previous reply did not match the required JSON schema:\n` +
    `${error.slice(0, MAX_ERROR_FEEDBACK_CHARS)}\n` +
    'Reply again with JSON that matches the schema exactly.'
  );
}

/** Wait before retry number `attempt` (1-based). Retry-After (seconds) wins when present. */
export function backoffMs(attempt: number, baseMs: number, retryAfter?: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : baseMs * 2 ** (attempt - 1);
  return Math.min(ms, MAX_RETRY_DELAY_MS);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function apiErrorOf(bodyText: string): { message: string; code?: string } {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const code = typeof parsed.error.code === 'string' ? parsed.error.code : undefined;
      return { message: redactSecrets(String(parsed.error.message ?? '')), code };
    }
  } catch {
    // not JSON: fall through to the raw text
  }
  return { message: redactSecrets(bodyText.slice(0, 300)) };
}

/** Map a failed HTTP exchange to an error whose message tells the user what to do. */
export function httpError(status: number, bodyText: string, model?: string): Error {
  // Our own words: OpenAI's 401 message echoes part of the key.
  if (status === 401) return new LLMUnavailableError('OPENAI_API_KEY rejected (HTTP 401): check the key in .env');
  const { message, code } = apiErrorOf(bodyText);
  if (model && (status === 404 || code === 'model_not_found')) {
    return new OpenAIError(
      `Model "${model}" is not available to this API key (HTTP ${status}): set RECEIPTS_MODEL (or RECEIPTS_GRADER_MODEL) to one it can use`,
      status,
    );
  }
  return new OpenAIError(`OpenAI HTTP ${status}${message ? `: ${message}` : ''}`, status);
}

/** A 400 about the `include` parameter: the account or model cannot list search sources. */
export function rejectsSourcesInclude(e: unknown): boolean {
  return e instanceof OpenAIError && e.status === 400 && /include/i.test(e.message);
}

// ---- HTTP --------------------------------------------------------------

interface HttpDeps {
  fetch: FetchLike;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

interface Exchange {
  status: number;
  ok: boolean;
  retryAfter: string | null;
  bodyText: string;
}

class RetryableHttpError extends Error {
  constructor(
    message: string,
    readonly retryAfter?: string | null,
  ) {
    super(message);
  }
}

// The timeout covers the body read too, not just the headers.
async function exchange(deps: HttpDeps, url: string, init: RequestInit): Promise<Exchange> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await deps.fetch(url, { ...init, signal: controller.signal });
    const bodyText = await res.text();
    return { status: res.status, ok: res.ok, retryAfter: res.headers.get('retry-after'), bodyText };
  } catch (e) {
    const reason = controller.signal.aborted ? `timed out after ${deps.timeoutMs}ms` : redactSecrets((e as Error).message);
    throw new RetryableHttpError(reason);
  } finally {
    clearTimeout(timer);
  }
}

function parseBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new OpenAIError('OpenAI returned a body that is not JSON');
  }
}

/** One HTTP exchange with retries on 429/5xx/network/timeout. Returns the parsed JSON body. */
async function requestJson(deps: HttpDeps, url: string, init: RequestInit, model?: string): Promise<unknown> {
  let last = 'unknown error';
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    try {
      const res = await exchange(deps, url, init);
      if (res.ok) return parseBody(res.bodyText);
      if (!isRetryableStatus(res.status)) throw httpError(res.status, res.bodyText, model);
      const { message } = apiErrorOf(res.bodyText);
      throw new RetryableHttpError(`HTTP ${res.status}${message ? `: ${message}` : ''}`, res.retryAfter);
    } catch (e) {
      if (!(e instanceof RetryableHttpError)) throw e;
      last = e.message;
      if (attempt < deps.maxAttempts) await deps.sleep(backoffMs(attempt, deps.retryDelayMs, e.retryAfter));
    }
  }
  throw new LLMUnavailableError(`OpenAI request failed after ${deps.maxAttempts} attempts: ${last}`);
}

function httpDeps(opts: Omit<OpenAIOptions, 'apiKey'>): HttpDeps {
  return {
    fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    retryDelayMs: opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    sleep: opts.sleep ?? ((ms) => Bun.sleep(ms)),
  };
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

export interface ListModelsOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Model ids the key can use (GET /models). Throws on failure. One attempt unless `maxAttempts` says more. */
export async function listModels(apiKey: string, opts: ListModelsOptions = {}): Promise<string[]> {
  const deps = httpDeps({ maxAttempts: 1, ...opts });
  const body = await requestJson(deps, `${opts.baseUrl ?? OPENAI_BASE_URL}/models`, { headers: authHeaders(apiKey) });
  const data = isRecord(body) ? asArray(body.data) : [];
  return data.flatMap((m) => (isRecord(m) && typeof m.id === 'string' ? [m.id] : []));
}

// ---- Client ------------------------------------------------------------

export class OpenAILLM implements LLM {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly deps: HttpDeps;
  private autoModel?: Promise<string>;
  private sourcesRejected = false;

  constructor(private readonly opts: OpenAIOptions) {
    if (!opts.apiKey) throw new LLMUnavailableError('OPENAI_API_KEY missing');
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? OPENAI_BASE_URL;
    this.deps = httpDeps(opts);
  }

  /**
   * Pinned model for the role, else the best one from the account's model
   * list. A good list is fetched once; a failed one falls back for this call
   * only, so one network blip does not pin the fallback for the whole run.
   */
  resolveModel(role: JsonRequest<unknown>['role'] = 'general'): Promise<string> {
    const pinned = role === 'grader' ? (this.opts.graderModel ?? this.opts.model) : this.opts.model;
    if (pinned) return Promise.resolve(pinned);
    this.autoModel ??= listModels(this.apiKey, { baseUrl: this.baseUrl, ...this.deps })
      .then(pickModel)
      .catch(() => {
        this.autoModel = undefined;
        return FALLBACK_MODEL;
      });
    return this.autoModel;
  }

  async json<T>(req: JsonRequest<T>): Promise<JsonResponse<T>> {
    const model = await this.resolveModel(req.role);
    const first = await this.call(model, req, req.user);
    const firstCheck = validateOutput(first.text, req.schema);
    if (firstCheck.ok) return this.response(firstCheck.data, first, model);

    const second = await this.call(model, req, retryPrompt(req.user, firstCheck.error));
    const secondCheck = validateOutput(second.text, req.schema);
    if (secondCheck.ok) return this.response(secondCheck.data, second, model);
    throw new OpenAIError(`${req.schemaName}: model output failed validation twice:\n${secondCheck.error}`);
  }

  private async call<T>(model: string, req: JsonRequest<T>, user: string): Promise<ParsedOutput> {
    try {
      return await this.post(model, buildResponsesBody(model, { ...req, user }, !this.sourcesRejected));
    } catch (e) {
      if (!req.webSearch || this.sourcesRejected || !rejectsSourcesInclude(e)) throw e;
      this.sourcesRejected = true;
      return this.post(model, buildResponsesBody(model, { ...req, user }, false));
    }
  }

  private async post(model: string, body: ResponsesRequestBody): Promise<ParsedOutput> {
    const raw = await requestJson(
      this.deps,
      `${this.baseUrl}/responses`,
      { method: 'POST', headers: authHeaders(this.apiKey), body: JSON.stringify(body) },
      model,
    );
    return parseResponsesOutput(raw);
  }

  private response<T>(data: T, out: ParsedOutput, model: string): JsonResponse<T> {
    return { data, citations: out.citations, ...(out.searched.length ? { searched: out.searched } : {}), model: out.model ?? model };
  }
}
