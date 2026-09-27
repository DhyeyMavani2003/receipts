import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { detectDrift } from '../src/drift.ts';
import { claimId, dueClaims, loadLedger, saveLedger } from '../src/ledger.ts';
import { LLMUnavailableError } from '../src/llm/provider.ts';
import { allowedHost, friendlyIngestError, localInputProblem, parseIngestRequest, replayMissSummary, sourceFor, startServer } from '../src/server.ts';
import type { GBrainSync, IngestEvent, RunningServer, ServerDeps } from '../src/server.ts';
import type { Claim, Transcript } from '../src/types.ts';
import { sampleLedger } from './site-fixtures.ts';

const TRANSCRIPT: Transcript = {
  text: 'Mara Quill: Robotaxis in ten cities by 2027.',
  segments: [{ speaker: 'Mara Quill', text: 'Robotaxis in ten cities by 2027.' }],
  meta: { title: 'The Long Drive #260', url: 'https://www.youtube.com/watch?v=ld260', date: '2025-01-15', kind: 'podcast' },
};

function newClaim(claim: string, targetDate: string): Claim {
  const saidDate = '2025-01-15';
  return {
    id: claimId('mara-quill', saidDate, claim),
    person: 'Mara Quill',
    personSlug: 'mara-quill',
    quote: claim,
    quoteVerified: true,
    claim,
    type: 'prediction',
    topic: 'vantage-robotaxi',
    saidDate,
    targetDate,
    resolutionCriteria: 'Reporting confirms it.',
    hedge: '',
    impliedProbability: 0.85,
    specificity: 4,
    source: { title: 'The Long Drive #260', url: 'https://www.youtube.com/watch?v=ld260', date: saidDate, kind: 'podcast' },
    verdict: 'pending',
    origin: 'extracted',
  };
}

const LINK = 'https://www.youtube.com/watch?v=ld260';
const DUE = newClaim('Vantage will open robotaxi rides to everyone in Austin in 2025.', '2025-12-31');
const LATER = newClaim('Vantage robotaxis will run in ten cities by the end of 2027.', '2027-12-31');

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** A pipeline with no model, network or gbrain: two verified claims, one of them due. */
function mockDeps(over: Partial<ServerDeps> = {}): Partial<ServerDeps> {
  return {
    getLLM: () => ({ name: 'mock', json: async () => { throw new Error('no model calls expected'); } }),
    loadTranscript: async () => TRANSCRIPT,
    extractClaims: async (_t, _llm, opts) => {
      opts.onProgress?.({ stage: 'chunk', message: 'Reading part 1 of 1' });
      for (const c of [DUE, LATER]) opts.onProgress?.({ stage: 'verified', message: `Verified: ${c.claim}`, claim: c });
      opts.onProgress?.({ stage: 'dropped', message: 'Dropped "x": not in transcript' });
      return { claims: [DUE, LATER], dropped: [{ quote: 'x', reason: 'not in transcript' }] };
    },
    gradeDue: async (l, _llm, opts) =>
      dueClaims(l, opts.today).map((c) => ({
        ...c,
        verdict: 'incorrect' as const,
        grading: { verdict: 'incorrect' as const, confidence: 0.9, rationale: 'Only a pilot ran in 2025.', evidence: [], gradedAt: '2026-09-27T00:00:00.000Z', gradedBy: 'mock' },
      })),
    refineDrift: async (l) => detectDrift(l),
    gbrain: () => null,
    ...over,
  };
}

function parseEvents(text: string): IngestEvent[] {
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter(Boolean)
    .map((d) => JSON.parse(d) as IngestEvent);
}

let dir: string;
let cfg: Config;
let server: RunningServer | undefined;

function serve(deps: Partial<ServerDeps> = mockDeps()): RunningServer {
  server = startServer(cfg, { port: 0, deps, log: () => {} });
  return server;
}

function ingest(s: RunningServer, body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(`${s.url}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init });
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await Bun.sleep(10);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'receipts-server-'));
  cfg = loadConfig({ ledgerPath: join(dir, 'ledger.json'), today: '2026-09-27', llmMode: 'replay', fixturesDir: join(dir, 'fixtures') });
  saveLedger(cfg.ledgerPath, sampleLedger());
});

afterEach(() => {
  server?.stop();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('pages', () => {
  test('GET / renders the live index with a nonce-matched CSP', async () => {
    const res = await fetch(`${serve().url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain('<form id="ingest-form"');
    expect(html).toContain('href="/p/mara-quill"');
  });

  test('GET /p/:slug renders a person; unknown people and paths are 404 pages', async () => {
    const s = serve();
    const person = await fetch(`${s.url}/p/mara-quill`);
    expect(person.status).toBe(200);
    expect(await person.text()).toContain('<h1>Mara Quill</h1>');
    const missing = await fetch(`${s.url}/p/nobody`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('No receipts on file for “nobody”.');
    expect((await fetch(`${s.url}/nope`)).status).toBe(404);
    expect((await fetch(`${s.url}/p/%E0%A4%A`)).status).toBe(404);
  });

  test('pages read the ledger file on every request', async () => {
    const s = serve();
    saveLedger(cfg.ledgerPath, { version: 1, updatedAt: '', claims: [LATER] });
    const html = await (await fetch(`${s.url}/`)).text();
    expect(html).not.toContain('Theo Brandt');
    expect(html).toContain('Mara Quill');
  });

  test('GET /api/ledger returns the ledger; other methods get 405', async () => {
    const s = serve();
    const body = (await (await fetch(`${s.url}/api/ledger`)).json()) as { claims: unknown[] };
    expect(body.claims).toHaveLength(sampleLedger().claims.length);
    const post = await fetch(`${s.url}/api/ledger`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });
});

describe('GET /api/ask', () => {
  test('an empty question is a 400 with a plain-language error', async () => {
    const res = await fetch(`${serve().url}/api/ask?q=%20`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('Ask a question');
  });

  test('answers offline from the ledger when no model is available', async () => {
    const s = serve(mockDeps({ getLLM: () => { throw new LLMUnavailableError('OPENAI_API_KEY missing'); } }));
    const res = await fetch(`${s.url}/api/ask?q=${encodeURIComponent('How much should I trust Mara Quill on robotaxis?')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; people: string[]; usedModel: boolean; html: string; receipts: { id: string }[] };
    expect(body.people).toEqual(['mara-quill']);
    expect(body.usedModel).toBe(false);
    expect(body.answer).toContain('Mara Quill');
    expect(body.receipts.length).toBeGreaterThan(0);
    expect(body.html).toContain(`href="/p/mara-quill#c-${body.receipts[0]!.id}"`);
  });

  test('falls back to the ledger-only answer when the model call fails', async () => {
    let calls = 0;
    const s = serve(
      mockDeps({
        ask: async (_q, _l, llm) => {
          calls++;
          if (llm) throw new Error('network down, key sk-abcdefghijklmnopqrstuvwxyz');
          return { answer: 'template', people: [], receipts: [], usedModel: false };
        },
      }),
    );
    const body = (await (await fetch(`${s.url}/api/ask?q=trust`)).json()) as { answer: string; note: string };
    expect(calls).toBe(2);
    expect(body.answer).toBe('template');
    expect(body.note).toContain('network down');
    expect(body.note).not.toContain('abcdefghijklmnop');
  });
});

describe('POST /api/ingest', () => {
  test('streams every stage, renders cards, grades due claims and saves the ledger', async () => {
    const res = await ingest(serve(), { input: 'https://www.youtube.com/watch?v=ld260', speaker: 'Mara Quill' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseEvents(await res.text());
    const stages = events.map((e) => e.stage);
    for (const s of ['load', 'chunk', 'verified', 'dropped', 'saved', 'grade', 'graded', 'drift', 'sync', 'complete'] as const) expect(stages).toContain(s);
    expect(stages.indexOf('saved')).toBeLessThan(stages.indexOf('graded'));
    expect(stages.indexOf('complete')).toBeGreaterThan(stages.indexOf('drift'));

    const verified = events.filter((e) => e.stage === 'verified');
    expect(verified).toHaveLength(2);
    expect(verified[0]!.html).toContain('class="receipt v-open is-new"');
    const graded = events.find((e) => e.stage === 'graded')!;
    expect(graded.claim!.id).toBe(DUE.id);
    expect(graded.html).toContain('stamp v-incorrect is-new');
    expect(events.find((e) => e.stage === 'drift')!.message).toContain('Deadline moved from 2024-12-31 to 2027-12-31.');
    expect(events.find((e) => e.stage === 'complete')!.href).toBe('/p/mara-quill');

    const saved = loadLedger(cfg.ledgerPath);
    expect(saved.claims).toHaveLength(sampleLedger().claims.length + 2);
    expect(saved.claims.find((c) => c.id === DUE.id)!.verdict).toBe('incorrect');
    expect(saved.claims.find((c) => c.id === LATER.id)!.drift?.label).toBe('pushed_later');
  });

  test('rejects bad requests with plain-language 400s and wrong methods with 405', async () => {
    const s = serve();
    const notJson = await fetch(`${s.url}/api/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'input=x' });
    expect(notJson.status).toBe(400);
    const noSpeaker = await ingest(s, { input: 'x.txt' });
    expect(noSpeaker.status).toBe(400);
    expect(((await noSpeaker.json()) as { error: string }).error).toContain('Add the speaker');
    expect((await fetch(`${s.url}/api/ingest`)).status).toBe(405);
  });

  test('one ingest at a time: a second request gets 409 until the first finishes', async () => {
    const gate = deferred();
    const base = mockDeps();
    const s = serve({ ...base, loadTranscript: async () => { await gate.promise; return TRANSCRIPT; } });
    const first = await ingest(s, { input: 'a.txt', speaker: 'Mara Quill', url: LINK });
    const second = await ingest(s, { input: 'b.txt', speaker: 'Mara Quill', url: LINK });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toContain('Another episode is being ingested');
    gate.resolve();
    expect(parseEvents(await first.text()).map((e) => e.stage)).toContain('complete');
    const third = await ingest(s, { input: 'c.txt', speaker: 'Mara Quill', url: LINK });
    expect(third.status).toBe(200);
    await third.text();
  });

  test('a closed browser tab does not stop the ingest: the ledger is still saved', async () => {
    const gate = deferred();
    const base = mockDeps();
    const s = serve({
      ...base,
      gradeDue: async (l, llm, opts) => {
        await gate.promise;
        return base.gradeDue!(l, llm, opts);
      },
    });
    const abort = new AbortController();
    const res = await ingest(s, { input: 'a.txt', speaker: 'Mara Quill', url: LINK }, { signal: abort.signal });
    const reader = res.body!.getReader();
    let seen = '';
    while (!seen.includes('"stage":"saved"')) seen += new TextDecoder().decode((await reader.read()).value);
    abort.abort();
    await reader.cancel().catch(() => {});
    gate.resolve();
    await waitFor(() => loadLedger(cfg.ledgerPath).claims.find((c) => c.id === DUE.id)?.verdict === 'incorrect');
    // The lock is released once the background run finishes.
    let next: Response | undefined;
    for (let i = 0; i < 100 && next?.status !== 200; i++) {
      next = await ingest(s, { input: 'b.txt', speaker: 'Mara Quill', url: LINK });
      if (next.status === 200) await next.text();
      else await Bun.sleep(10);
    }
    expect(next!.status).toBe(200);
  });

  test('a failing stage becomes an error event with secrets redacted; earlier stages stay saved', async () => {
    const s = serve(mockDeps({ refineDrift: async () => { throw new Error('drift exploded near sk-proj-abcdefghijklmnop'); } }));
    const events = parseEvents(await (await ingest(s, { input: 'a.txt', speaker: 'Mara Quill', url: LINK })).text());
    const error = events.at(-1)!;
    expect(error.stage).toBe('error');
    expect(error.message).toContain('drift exploded');
    expect(error.message).toContain('sk-***');
    expect(error.message).not.toContain('abcdefghijklmnop');
    expect(loadLedger(cfg.ledgerPath).claims.find((c) => c.id === DUE.id)!.verdict).toBe('incorrect');
  });

  test('offline replay misses collapse into one friendly line; the server console keeps each one', async () => {
    const logs: string[] = [];
    server = startServer(cfg, {
      port: 0,
      log: (l) => logs.push(l),
      deps: mockDeps({
        extractClaims: async () => ({ claims: [DUE, { ...LATER, id: 'due-2', targetDate: '2025-06-30' }], dropped: [] }),
        gradeDue: async (l, _llm, opts) => {
          for (const c of dueClaims(l, opts.today)) {
            opts.onProgress?.({ claimId: c.id, message: `Grading: ${c.claim}` });
            opts.onProgress?.({ claimId: c.id, message: 'Not graded: No replay fixture for grade_claim (/secret/path/x.json). Record it first.' });
          }
          return [];
        },
      }),
    });
    const events = parseEvents(await (await ingest(server, { input: 'a.txt', speaker: 'Mara Quill', url: LINK })).text());
    const messages = events.map((e) => e.message);
    expect(messages.filter((m) => m.includes('No replay fixture'))).toEqual([]);
    expect(messages).toContain(replayMissSummary(2));
    expect(replayMissSummary(2)).toBe('2 predictions not graded offline: there is no recorded grading for them. Add OPENAI_API_KEY and run "receipts grade" to grade them live.');
    expect(logs.filter((l) => l.includes('No replay fixture'))).toHaveLength(2);
  });

  test('a yt-dlp failure shows only the final ERROR line plus a hint; the console keeps the raw stderr', async () => {
    const raw =
      'yt-dlp failed (exit 1): WARNING: [youtube] abc: Some formats may be missing | [youtube] abc: Downloading webpage | ERROR: [youtube] abc: Unable to download video subtitles: HTTP Error 429: Too Many Requests';
    const logs: string[] = [];
    server = startServer(cfg, {
      port: 0,
      log: (l) => logs.push(l),
      deps: mockDeps({ loadTranscript: async () => { throw new Error(raw); } }),
    });
    const events = parseEvents(await (await ingest(server, { input: 'https://www.youtube.com/watch?v=abc', speaker: 'Mara Quill' })).text());
    const error = events.at(-1)!;
    expect(error.stage).toBe('error');
    expect(error.message).toBe(
      'ERROR: [youtube] abc: Unable to download video subtitles: HTTP Error 429: Too Many Requests. YouTube is rate-limiting this network; save captions with yt-dlp later or ingest a transcript file.',
    );
    expect(error.message).not.toContain('WARNING');
    expect(logs.some((l) => l.includes('WARNING: [youtube] abc') && l.includes('Downloading webpage'))).toBe(true);
  });

  test('friendlyIngestError leaves other errors alone and gives a non-429 yt-dlp failure the generic hint', () => {
    expect(friendlyIngestError('drift exploded')).toBe('drift exploded');
    expect(friendlyIngestError('yt-dlp failed (exit 1): ERROR: [youtube] x: Video unavailable')).toBe(
      'ERROR: [youtube] x: Video unavailable. YouTube did not hand over captions; try again later, or ingest a saved transcript file (.vtt, .srt, .txt).',
    );
    expect(friendlyIngestError('yt-dlp failed (exit 2): something odd')).toContain('something odd');
  });

  test('no model configured: a clear error before anything is loaded', async () => {
    let loaded = false;
    const s = serve(
      mockDeps({
        getLLM: () => { throw new LLMUnavailableError('OPENAI_API_KEY missing: add it to .env, or run offline with --offline'); },
        loadTranscript: async () => { loaded = true; return TRANSCRIPT; },
      }),
    );
    const events = parseEvents(await (await ingest(s, { input: 'a.txt', speaker: 'Mara Quill', url: LINK })).text());
    expect(events).toEqual([{ stage: 'error', message: 'OPENAI_API_KEY missing: add it to .env, or run offline with --offline' }]);
    expect(loaded).toBe(false);
  });

  test('syncs to GBrain when it is available and keeps the row numbers', async () => {
    const synced: string[] = [];
    const gb: GBrainSync = {
      available: async () => true,
      syncClaims: async (l, opts) => {
        synced.push(opts?.personSlug ?? '');
        opts?.onProgress?.('people/mara-quill: added 2 takes');
        return { ...l, claims: l.claims.map((c) => (c.id === LATER.id ? { ...c, gbrain: { page: 'people/mara-quill', row: 42 } } : c)) };
      },
    };
    const s = serve(mockDeps({ gbrain: () => gb }));
    const events = parseEvents(await (await ingest(s, { input: 'a.txt', speaker: 'Mara Quill', url: LINK })).text());
    expect(synced).toEqual(['mara-quill']);
    expect(events.map((e) => e.message)).toContain('Writing to GBrain (1): people/mara-quill: added 2 takes');
    expect(loadLedger(cfg.ledgerPath).claims.find((c) => c.id === LATER.id)!.gbrain?.row).toBe(42);
    const updated = events.filter((e) => e.stage === 'updated' && e.claim?.id === LATER.id).at(-1);
    expect(updated?.html).toContain('GBrain take #42');
  });

  test('GBrain missing: completes, then says so', async () => {
    const s = serve(mockDeps({ gbrain: () => ({ available: async () => false, syncClaims: async (l) => l }) }));
    const stages = parseEvents(await (await ingest(s, { input: 'a.txt', speaker: 'Mara Quill', url: LINK })).text()).map((e) => e.stage);
    expect(stages.at(-1)).toBe('sync');
    expect(stages.indexOf('complete')).toBeGreaterThan(stages.indexOf('drift'));
  });

  test('"complete" comes before the slow GBrain sync, and the sync is one updating status', async () => {
    const gb: GBrainSync = {
      available: async () => true,
      syncClaims: async (l, opts) => {
        for (const m of ['timeline 1', 'take #1', 'take #2']) opts?.onProgress?.(m);
        return l;
      },
    };
    const events = parseEvents(await (await ingest(serve(mockDeps({ gbrain: () => gb })), { input: 'a.txt', speaker: 'Mara Quill', url: LINK })).text());
    const stages = events.map((e) => e.stage);
    expect(stages.indexOf('complete')).toBeLessThan(stages.indexOf('sync'));
    expect(events.filter((e) => e.stage === 'sync').map((e) => e.message)).toEqual([
      'Writing people/mara-quill to GBrain…',
      'Writing to GBrain (1): timeline 1',
      'Writing to GBrain (2): take #1',
      'Writing to GBrain (3): take #2',
      'GBrain page people/mara-quill is up to date.',
    ]);
  });

  test('another process saving mid-ingest keeps its changes', async () => {
    const gate = deferred();
    const base = mockDeps();
    const s = serve({ ...base, gradeDue: async (l, llm, opts) => { await gate.promise; return base.gradeDue!(l, llm, opts); } });
    const res = await ingest(s, { input: 'a.txt', speaker: 'Mara Quill', url: LINK });
    const reader = res.body!.getReader();
    let seen = '';
    while (!seen.includes('"stage":"saved"')) seen += new TextDecoder().decode((await reader.read()).value);
    // A CLI run grades someone else's claim while this ingest waits on its grader.
    const l = loadLedger(cfg.ledgerPath);
    const other = l.claims.find((c) => c.personSlug !== 'mara-quill' && c.verdict === 'pending')!;
    other.verdict = 'correct';
    saveLedger(cfg.ledgerPath, l);
    gate.resolve();
    while (!(await reader.read()).done);
    expect(loadLedger(cfg.ledgerPath).claims.find((c) => c.id === other.id)!.verdict).toBe('correct');
    expect(loadLedger(cfg.ledgerPath).claims.find((c) => c.id === DUE.id)!.verdict).toBe('incorrect');
  });
});

describe('cross-site and local-file protection', () => {
  test('a text/plain POST (no CORS preflight) is refused with 415', async () => {
    const res = await fetch(`${serve().url}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ input: 'a.txt', speaker: 'Mara Quill', url: LINK }),
    });
    expect(res.status).toBe(415);
  });

  test('another site\'s Origin or Fetch Metadata is refused on every API route', async () => {
    const s = serve();
    const evil = await ingest(s, { input: 'a.txt', speaker: 'Mara Quill', url: LINK }, { headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect((await fetch(`${s.url}/api/ask?q=trust`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await fetch(`${s.url}/api/ledger`, { headers: { origin: 'null' } })).status).toBe(403);
    const same = await fetch(`${s.url}/api/ledger`, { headers: { origin: s.url, 'sec-fetch-site': 'same-origin' } });
    expect(same.status).toBe(200);
  });

  test('a request for another host name (DNS rebinding) gets 421', async () => {
    const s = serve();
    const res = await fetch(`${s.url}/api/ledger`, { headers: { host: `evil.example:${s.port}` } });
    expect(res.status).toBe(421);
  });

  test('allowedHost: loopback names on this port only (DNS rebinding)', () => {
    expect(allowedHost('127.0.0.1:4321', 4321, '127.0.0.1')).toBe(true);
    expect(allowedHost('LOCALHOST:4321', 4321, '127.0.0.1')).toBe(true);
    expect(allowedHost('evil.example:4321', 4321, '127.0.0.1')).toBe(false);
    expect(allowedHost('127.0.0.1:80', 4321, '127.0.0.1')).toBe(false);
    expect(allowedHost(null, 4321, '127.0.0.1')).toBe(false);
  });

  test('the form reads only transcript/audio files outside hidden folders, and needs their public link', async () => {
    const s = serve();
    for (const input of ['/home/me/.ssh/id_ed25519.txt', '/home/me/.ssh/id_ed25519', '/etc/passwd', 'notes.pdf']) {
      const res = await ingest(s, { input, speaker: 'Mara Quill', url: LINK });
      expect(res.status).toBe(400);
    }
    const noLink = await ingest(s, { input: 'a.txt', speaker: 'Mara Quill' });
    expect(noLink.status).toBe(400);
    expect(((await noLink.json()) as { error: string }).error).toContain('source link');
    expect(localInputProblem('./fixtures/transcripts/ep.vtt')).toBeNull();
    expect(localInputProblem('https://example.com/.hidden/page')).toBeNull();
  });
});

describe('request helpers', () => {
  test('parseIngestRequest trims, drops empty optionals and validates', () => {
    expect(parseIngestRequest({ input: ' ep.vtt ', speaker: ' Mara ', title: '', date: '2025-01-15', url: LINK, extra: 1 })).toEqual({
      ok: true,
      value: { input: 'ep.vtt', speaker: 'Mara', date: '2025-01-15', url: LINK },
    });
    expect(parseIngestRequest({ input: 'ep.vtt', speaker: 'Mara' })).toMatchObject({ ok: false, error: expect.stringContaining('source link') });
    expect(parseIngestRequest({ input: LINK, speaker: 'Mara' })).toMatchObject({ ok: true });
    expect(parseIngestRequest(null)).toMatchObject({ ok: false });
    expect(parseIngestRequest([])).toMatchObject({ ok: false });
    expect(parseIngestRequest({ input: 'x', speaker: 'y', date: '15/01/2025' })).toMatchObject({ ok: false, error: expect.stringContaining('2024-05-31') });
    expect(parseIngestRequest({ input: 'x', speaker: 'y', url: 'javascript:alert(1)' })).toMatchObject({ ok: false });
    expect(parseIngestRequest({ input: 'x', speaker: 'y', kind: 'tweetstorm' })).toMatchObject({ ok: false });
    expect(parseIngestRequest({ input: 5, speaker: 'y' })).toMatchObject({ ok: false, error: '"input" must be text.' });
    expect(parseIngestRequest({ input: 'x', speaker: 'y'.repeat(121) })).toMatchObject({ ok: false });
  });

  test('sourceFor prefers explicit fields, then transcript metadata, then fallbacks', () => {
    const bare: Transcript = { text: '', segments: [], meta: {} };
    expect(sourceFor(bare, { input: '/tmp/ep 1.txt', speaker: 'M', url: LINK }, '2026-09-27')).toEqual({
      title: 'ep 1.txt',
      url: LINK,
      date: '2026-09-27',
      kind: 'podcast',
    });
    expect(() => sourceFor(bare, { input: '/tmp/ep 1.txt', speaker: 'M' }, '2026-09-27')).toThrow('source link');
    expect(sourceFor(TRANSCRIPT, { input: 'x', speaker: 'M', title: 'T', kind: 'interview' }, '2026-09-27')).toEqual({
      title: 'T',
      url: 'https://www.youtube.com/watch?v=ld260',
      date: '2025-01-15',
      kind: 'interview',
    });
  });
});
