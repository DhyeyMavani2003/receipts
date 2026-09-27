import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { DiscoverEvent, DiscoverOptions, DiscoverResult } from '../src/discover.ts';
import { saveLedger } from '../src/ledger.ts';
import { LLMUnavailableError } from '../src/llm/provider.ts';
import { appMode, humanPullEvents, startServer } from '../src/server.ts';
import type { IngestEvent, RunningServer, ServerDeps } from '../src/server.ts';
import type { Candidate } from '../src/types.ts';
import { discoveriesPath, loadDiscoveries, loadWatchlist, watchlistPath } from '../src/watchlist.ts';
import { sampleLedger } from './site-fixtures.ts';

const CAND: Candidate = {
  title: 'All-In Summit <b>AI factories</b>',
  show: 'All-In Podcast',
  date: '2026-09-06',
  url: 'https://www.youtube.com/watch?v=abc123',
  kind: 'podcast',
  durationMin: 58,
  transcriptSource: 'youtube',
  why: 'China export rules and AGI timing.',
  linkConfirmed: true,
};

let dir: string;
let cfg: Config;
let server: RunningServer | undefined;
let discoverCalls = 0;

function deps(over: Partial<ServerDeps> = {}): Partial<ServerDeps> {
  return {
    getLLM: () => ({
      name: 'mock',
      json: async () => {
        throw new LLMUnavailableError('no model in tests');
      },
    }),
    gbrain: () => null,
    discoverAppearances: async (person: string, _llm, opts: DiscoverOptions): Promise<DiscoverResult> => {
      discoverCalls++;
      const emit = (e: DiscoverEvent) => opts.onProgress?.(e);
      emit({ stage: 'searching', message: `Searching the web for ${person}'s recent interviews, podcasts and talks...` });
      emit({ stage: 'found', message: 'Found 1 appearances. 0 already in your receipts.', count: 1 });
      emit({ stage: 'candidate', message: CAND.title, candidate: CAND });
      emit({ stage: 'complete', message: 'Done. Pick one to pull receipts from.', count: 1 });
      return { person, slug: 'jensen-huang', since: '2026-03-31', candidates: [CAND], have: [], dropped: [], model: 'mock' };
    },
    ...over,
  };
}

function serve(d: Partial<ServerDeps> = deps()): RunningServer {
  server = startServer(cfg, { port: 0, deps: d, log: () => {} });
  return server;
}

function post(s: RunningServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${s.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

type AnyEvent = Omit<IngestEvent, 'stage'> & { stage: string; slug?: string };

function events(text: string): AnyEvent[] {
  return text
    .split('\n\n')
    .map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter(Boolean)
    .map((d) => JSON.parse(d));
}

beforeEach(() => {
  discoverCalls = 0;
  dir = mkdtempSync(join(tmpdir(), 'receipts-dash-'));
  cfg = loadConfig({ ledgerPath: join(dir, 'ledger.json'), today: '2026-09-27', llmMode: 'replay', fixturesDir: join(dir, 'fixtures') });
  saveLedger(cfg.ledgerPath, sampleLedger());
});

afterEach(() => {
  server?.stop();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('dashboard pages', () => {
  test('GET / is the one-box dashboard with a nonce CSP and the offline badge', async () => {
    const res = await fetch(`${serve().url}/`);
    const html = await res.text();
    const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
    expect(res.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`);
    expect(res.headers.get('content-security-policy')).not.toContain('googleapis');
    expect(html).toContain('id="box"');
    expect(html).toContain('Offline replay');
    expect(html).toContain('coming due before the end of the year?');
  });

  test('GET /classic keeps the old live index', async () => {
    const html = await (await fetch(`${serve().url}/classic`)).text();
    expect(html).toContain('Leaderboard');
  });

  test('/p/<slug> works for a followed person with no receipts', async () => {
    const s = serve();
    expect((await fetch(`${s.url}/p/lisa-su`)).status).toBe(404);
    await post(s, '/api/follow', { name: 'lisa su' });
    const res = await fetch(`${s.url}/p/lisa-su`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>Lisa Su</h1>');
  });

  test('status reports the mode and counts, never a key', async () => {
    const body = (await (await fetch(`${serve().url}/api/status`)).json()) as Record<string, unknown>;
    expect(body.mode).toBe('replay');
    expect(body.claims).toBe(sampleLedger().claims.length);
    expect(JSON.stringify(body)).not.toContain('sk-');
  });

  test('appMode', () => {
    expect(appMode({ llmMode: 'replay', openaiKey: 'x' })).toBe('replay');
    expect(appMode({ llmMode: 'openai', openaiKey: undefined })).toBe('no-key');
    expect(appMode({ llmMode: 'openai', openaiKey: 'k' })).toBe('live');
  });
});

describe('dashboard api', () => {
  test('input routes without side effects', async () => {
    const s = serve();
    const route = async (text: string) => ((await (await post(s, '/api/input', { text })).json()) as { route: { kind: string; name?: string } }).route;
    expect((await route('follow Lisa Su')).kind).toBe('follow');
    expect((await route('Who has been most wrong about robotaxis?')).kind).toBe('ask');
    expect((await route('https://www.youtube.com/watch?v=abc123 Mara Quill')).kind).toBe('pull');
    expect(loadWatchlist(watchlistPath(cfg.ledgerPath)).people).toHaveLength(0);
  });

  test('follow then unfollow', async () => {
    const s = serve();
    const f = (await (await post(s, '/api/follow', { name: 'jensen huang' })).json()) as { person: { slug: string; name: string }; created: boolean; html: string };
    expect(f.person.name).toBe('Jensen Huang');
    expect(f.created).toBe(true);
    expect(f.html).toContain('Not checked yet.');
    const again = (await (await post(s, '/api/follow', { name: 'Jensen Huang' })).json()) as { created: boolean };
    expect(again.created).toBe(false);
    const u = (await (await post(s, '/api/unfollow', { name: 'jensen-huang' })).json()) as { ok: boolean };
    expect(u.ok).toBe(true);
    expect(loadWatchlist(watchlistPath(cfg.ledgerPath)).people).toHaveLength(0);
  });

  test('discover streams rows, stores the run, follows, and reuses a fresh result', async () => {
    const s = serve();
    const res = await post(s, '/api/discover', { name: 'Jensen Huang' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const ev = events(await res.text());
    expect(ev.map((e) => e.stage)).toEqual(['searching', 'found', 'candidate', 'panel', 'card', 'complete']);
    expect(ev.find((e) => e.stage === 'candidate')!.html).toContain('&lt;b&gt;AI factories');
    expect(loadDiscoveries(discoveriesPath(cfg.ledgerPath)).bySlug['jensen-huang']!.candidates).toHaveLength(1);
    expect(loadWatchlist(watchlistPath(cfg.ledgerPath)).people.map((p) => p.slug)).toEqual(['jensen-huang']);
    const again = events(await (await post(s, '/api/discover', { slug: 'jensen-huang' })).text());
    expect(again.map((e) => e.stage)).toEqual(['note', 'panel', 'complete']);
    expect(discoverCalls).toBe(1);
    const forced = events(await (await post(s, '/api/discover', { slug: 'jensen-huang', force: true })).text());
    expect(forced.map((e) => e.stage)).toContain('candidate');
    expect(discoverCalls).toBe(2);
  });

  test('a second discover for the same person while one runs is a 409', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = deps({
      discoverAppearances: async (person) => {
        await gate;
        return { person, slug: 'jensen-huang', since: '2026-03-31', candidates: [], have: [], dropped: [], model: 'mock' };
      },
    });
    const s = serve(slow);
    const first = post(s, '/api/discover', { name: 'Jensen Huang' });
    await Bun.sleep(50);
    const second = await post(s, '/api/discover', { name: 'Jensen Huang' });
    expect(second.status).toBe(409);
    release();
    const ev = events(await (await first).text());
    expect(ev.at(-1)!.message).toContain('No new long-form appearances');
  });

  test('discover offline with no recording says so in plain words', async () => {
    const s = serve(
      deps({
        discoverAppearances: async () => {
          throw new LLMUnavailableError('No replay fixture for discover_appearances');
        },
      }),
    );
    const ev = events(await (await post(s, '/api/discover', { name: 'Lisa Su' })).text());
    expect(ev.at(-1)!.stage).toBe('error');
    expect(ev.at(-1)!.message).toContain('there is no recording of a search for Lisa Su');
  });

  test('pull: stored candidate goes through pullCandidate with human wording; private URLs are refused', async () => {
    let seen: { url: string; name: string; max?: number } | undefined;
    const s = serve(
      deps({
        pullCandidate: async (c, person, opts) => {
          seen = { url: c.url, name: person.name, max: opts.maxMinutes };
          opts.send({ stage: 'load', message: 'Loading x' });
          opts.send({ stage: 'chunk', message: 'Reading part 1 of 2' });
          opts.send({ stage: 'candidates', message: 'Part 1: 14 candidate claims' });
          opts.send({ stage: 'dropped', message: 'Dropped "x"' });
          opts.send({ stage: 'saved', message: 'Saved 3 new claims', count: 3 });
          opts.send({ stage: 'complete', message: 'Done: 3 new receipts for Jensen Huang.', count: 3, href: '/p/jensen-huang' });
        },
      }),
    );
    await post(s, '/api/discover', { name: 'Jensen Huang' }).then((r) => r.text());
    const ev = events(await (await post(s, '/api/pull', { slug: 'jensen-huang', url: CAND.url, maxMinutes: 20 })).text());
    expect(seen).toEqual({ url: CAND.url, name: 'Jensen Huang', max: 20 });
    const lines = ev.map((e) => e.message);
    expect(lines).toContain('Reading the transcript (part 1 of 2)...');
    expect(lines).toContain('Checking 14 quotes word for word...');
    expect(lines).toContain('Saved 3 new receipts.');
    expect(lines).toContain('1 quote did not match the transcript word for word and was left out.');
    expect(lines).not.toContain('Loading x');
    expect(ev.at(-1)!.person).toBe('Jensen Huang');

    const priv = await post(s, '/api/pull', { url: 'http://192.168.1.2/x', speaker: 'Mara Quill' });
    expect(priv.status).toBe(400);
    const missing = await post(s, '/api/pull', { slug: 'jensen-huang', url: 'https://www.youtube.com/watch?v=zzz' });
    expect(missing.status).toBe(404);
  });

  test('pull shares the one-at-a-time lock (409)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = serve(deps({ pullCandidate: async () => gate }));
    const first = post(s, '/api/pull', { url: 'https://www.youtube.com/watch?v=abc123', speaker: 'Mara Quill' });
    await Bun.sleep(50);
    expect((await post(s, '/api/pull', { url: 'https://www.youtube.com/watch?v=abc123', speaker: 'Mara Quill' })).status).toBe(409);
    release();
    await (await first).text();
  });

  test('POST /api/ask answers from the receipts with server-rendered html', async () => {
    const s = serve();
    const res = await post(s, '/api/ask', { q: 'How much should I trust Mara Quill on robotaxis?' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; html: string; usedModel: boolean };
    expect(body.usedModel).toBe(false);
    expect(body.html).toContain('class="answer-card"');
    expect(body.html).toContain('You asked: How much should I trust Mara Quill on robotaxis?');
    const unknown = (await (await post(s, '/api/ask', { q: 'Is Lisa Su right about chips?' })).json()) as { html: string };
    expect(unknown.html).toContain('data-follow="Lisa Su"');
  });

  test('new POST routes enforce JSON, same-origin and the Host check', async () => {
    const s = serve();
    for (const path of ['/api/input', '/api/follow', '/api/unfollow', '/api/discover', '/api/pull']) {
      const plain = await fetch(`${s.url}${path}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
      expect(plain.status).toBe(415);
    }
    const ask = await fetch(`${s.url}/api/ask`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(ask.status).toBe(415);
    expect((await post(s, '/api/follow', { name: 'X Y' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${s.url}/api/status`, { headers: { host: 'evil.example:80' } })).status).toBe(421);
  });

  test('watchlist and feed', async () => {
    const s = serve();
    await post(s, '/api/follow', { name: 'Mara Quill' });
    const w = (await (await fetch(`${s.url}/api/watchlist`)).json()) as { people: { slug: string; record: string }[] };
    expect(w.people[0]!.slug).toBe('mara-quill');
    expect(w.people[0]!.record).toMatch(/came true|waiting/);
    const f = (await (await fetch(`${s.url}/api/feed`)).json()) as { items: unknown[] };
    expect(Array.isArray(f.items)).toBe(true);
  });
});

describe('humanPullEvents', () => {
  test('maps drift, sync and errors to plain lines', () => {
    const out: IngestEvent[] = [];
    const send = humanPullEvents((e) => out.push(e), 'Mara Quill');
    send({ stage: 'drift', message: 'Story drift: Deadline moved from 2025 to 2026.' });
    send({ stage: 'drift', message: 'No deadline or goalpost changes against earlier claims on these topics.' });
    send({ stage: 'sync', message: 'GBrain CLI not found, so person pages were not updated.' });
    send({ stage: 'complete', message: 'No checkable claims by Mara Quill were found in this source.', count: 0 });
    send({ stage: 'error', message: 'No replay fixture for extract_claims (abc)' });
    expect(out.map((e) => e.message)).toEqual([
      'Story moved: Deadline moved from 2025 to 2026.',
      'No change against what they said before.',
      'GBrain is not installed, so the brain was not updated. Everything is saved here.',
      'No checkable claims by Mara Quill in this source.',
      'There is no recording for this, and live mode is off. Add OPENAI_API_KEY to .env and restart with "receipts start".',
    ]);
  });
});
