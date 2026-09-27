// Discovery: URL helpers, validation, ranking, the web-search call (MockLLM),
// record/replay, link checks and pullCandidate with a stub ingest. Offline.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configFromEnv } from '../src/config.ts';
import {
  DISCOVER_SYSTEM,
  appLoadTranscript,
  checkLink,
  discoverAppearances,
  discoverUserPrompt,
  humanDate,
  isPublicHttpUrl,
  pullCandidate,
  rankCandidates,
  sourceKey,
  transcriptCacheDir,
  transcriptSourceOf,
  validateCandidates,
} from '../src/discover.ts';
import type { DiscoverEvent, RawCandidate } from '../src/discover.ts';
import { MockLLM } from '../src/llm/mock.ts';
import { RecordingLLM, ReplayLLM } from '../src/llm/replay.ts';
import { defaultDeps } from '../src/server.ts';
import type { IngestEvent, IngestRequest, ServerDeps } from '../src/server.ts';
import { writeCachedTranscript } from '../src/transcript/load.ts';
import type { Candidate } from '../src/types.ts';
import { discoveriesPath, loadDiscoveries, recordDiscovery } from '../src/watchlist.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'receipts-discover-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TODAY = '2026-09-27';
const SINCE = '2026-03-31';

function raw(over: Partial<RawCandidate> = {}): RawCandidate {
  return {
    title: 'Jensen Huang on AI factories',
    show: 'All-In Podcast',
    host: 'Jason Calacanis',
    date: '2026-09-06',
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    kind: 'podcast',
    duration_min: 58,
    transcript_source: 'youtube',
    why: 'A long sit-down on export rules and AGI timing.',
    ...over,
  };
}

function cand(over: Partial<Candidate> = {}): Candidate {
  return {
    title: 'T',
    show: 'S',
    date: '2026-09-01',
    url: 'https://example.com/a',
    kind: 'podcast',
    transcriptSource: 'page',
    why: 'w',
    linkConfirmed: true,
    ...over,
  };
}

describe('sourceKey', () => {
  test('every YouTube form gives one key', () => {
    const forms = [
      'https://www.youtube.com/watch?v=abcdefghijk',
      'https://youtube.com/watch?v=abcdefghijk&t=120s',
      'https://m.youtube.com/watch?v=abcdefghijk',
      'https://youtu.be/abcdefghijk?si=xyz',
      'https://www.youtube.com/live/abcdefghijk',
      'https://www.youtube.com/embed/abcdefghijk',
      'https://www.youtube.com/shorts/abcdefghijk',
    ];
    for (const f of forms) expect(sourceKey(f)).toBe('youtube:abcdefghijk');
  });

  test('urlKey for other hosts; bad URLs null', () => {
    expect(sourceKey('https://www.example.com/ep/1/?utm_source=x#t')).toBe('example.com/ep/1');
    expect(sourceKey('not a url')).toBeNull();
    expect(sourceKey('ftp://example.com/x')).toBeNull();
  });
});

describe('isPublicHttpUrl', () => {
  test.each([
    'http://127.0.0.1/x',
    'http://localhost:4321/',
    'http://10.0.0.1/',
    'http://192.168.1.2/',
    'http://172.16.5.4/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://printer.local/',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'https://user:pw@example.com/',
    'http://intranet/',
  ])('rejects %p', (u) => expect(isPublicHttpUrl(u)).toBe(false));

  test.each(['https://www.youtube.com/watch?v=abcdefghijk', 'https://youtu.be/abcdefghijk', 'https://example.com/podcast/ep-1', 'http://8.8.8.8/'])(
    'accepts %p',
    (u) => expect(isPublicHttpUrl(u)).toBe(true),
  );
});

describe('transcriptSourceOf', () => {
  test('YouTube host wins; audio extension; youtube claim downgraded elsewhere', () => {
    expect(transcriptSourceOf('https://youtu.be/abcdefghijk', 'unknown')).toBe('youtube');
    expect(transcriptSourceOf('https://cdn.example.com/ep.mp3', 'page')).toBe('audio');
    expect(transcriptSourceOf('https://example.com/ep', 'youtube')).toBe('page');
    expect(transcriptSourceOf('https://example.com/ep', 'unknown')).toBe('unknown');
  });
});

describe('validateCandidates', () => {
  const ctxEmpty = { today: TODAY, since: SINCE, searched: [], citations: [] };

  test('future date blanked, pre-window dropped', () => {
    const { kept, dropped } = validateCandidates(
      [raw({ date: '2026-12-01' }), raw({ url: 'https://youtu.be/bbbbbbbbbbb', date: '2025-01-01' }), raw({ url: 'https://youtu.be/ccccccccccc', date: 'Sept 2026' })],
      ctxEmpty,
    );
    expect(kept.map((c) => c.date)).toEqual(['', '']);
    expect(dropped).toEqual([{ url: 'https://youtu.be/bbbbbbbbbbb', reason: 'older than the window' }]);
  });

  test('short clips and Shorts dropped; a 5 to 10 minute clip kept only when it is the only option', () => {
    const r1 = validateCandidates([raw({ duration_min: 3 }), raw({ url: 'https://www.youtube.com/shorts/ddddddddddd', duration_min: null })], ctxEmpty);
    expect(r1.kept).toHaveLength(0);
    expect(r1.dropped.map((d) => d.reason)).toEqual(['a short clip', 'a YouTube Short']);
    const alone = validateCandidates([raw({ duration_min: 7 })], ctxEmpty);
    expect(alone.kept).toHaveLength(1);
    const withLong = validateCandidates([raw({ duration_min: 7 }), raw({ url: 'https://youtu.be/eeeeeeeeeee', duration_min: 45 })], ctxEmpty);
    expect(withLong.kept.map((c) => c.durationMin)).toEqual([45]);
    expect(withLong.dropped).toEqual([{ url: 'https://www.youtube.com/watch?v=abcdefghijk', reason: 'a short clip' }]);
  });

  test('unconfirmed non-YouTube dropped when the search listed pages; YouTube kept unconfirmed', () => {
    const ctx = { today: TODAY, since: SINCE, searched: [{ url: 'https://www.example.com/found/' }], citations: [] };
    const { kept, dropped } = validateCandidates(
      [
        raw({ url: 'https://example.com/found', transcript_source: 'page' }),
        raw({ url: 'https://example.com/guessed', transcript_source: 'page' }),
        raw({ url: 'https://youtu.be/fffffffffff' }),
      ],
      ctx,
    );
    expect(kept.map((c) => [c.url, c.linkConfirmed])).toEqual([
      ['https://example.com/found', true],
      ['https://youtu.be/fffffffffff', false],
    ]);
    expect(dropped).toEqual([{ url: 'https://example.com/guessed', reason: 'link not found in the search results' }]);
  });

  test('both lists empty: everything kept with linkConfirmed false', () => {
    const { kept } = validateCandidates([raw({ url: 'https://example.com/a', transcript_source: 'page' }), raw()], ctxEmpty);
    expect(kept.every((c) => c.linkConfirmed === false)).toBe(true);
    expect(kept).toHaveLength(2);
  });

  test('in-result dedupe by sourceKey, private and social links, empty titles, signed params', () => {
    const { kept, dropped } = validateCandidates(
      [
        raw(),
        raw({ url: 'https://youtu.be/abcdefghijk' }),
        raw({ url: 'http://192.168.0.2/ep' }),
        raw({ url: 'https://x.com/jensen/status/1' }),
        raw({ url: 'https://example.com/b', title: '  ' }),
        raw({ url: 'https://example.com/c?token=secret&ep=2', transcript_source: 'page' }),
      ],
      ctxEmpty,
    );
    expect(kept.map((c) => c.url)).toEqual(['https://www.youtube.com/watch?v=abcdefghijk', 'https://example.com/c?ep=2']);
    expect(dropped.map((d) => d.reason)).toEqual(['a duplicate', 'not a public web link', 'a social media post', 'missing a title or description']);
  });

  test('maps fields: host null omitted, duration rounded', () => {
    const [c] = validateCandidates([raw({ host: null, duration_min: 57.6 })], ctxEmpty).kept;
    expect(c).toEqual({
      title: 'Jensen Huang on AI factories',
      show: 'All-In Podcast',
      date: '2026-09-06',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      kind: 'podcast',
      durationMin: 58,
      transcriptSource: 'youtube',
      why: 'A long sit-down on export rules and AGI timing.',
      linkConfirmed: false,
    });
  });
});

describe('rankCandidates', () => {
  test('date desc (undated last), then youtube before page, then longer, then title', () => {
    const cs = [
      cand({ title: 'undated', date: '' }),
      cand({ title: 'old', date: '2026-04-01' }),
      cand({ title: 'page', date: '2026-09-01' }),
      cand({ title: 'yt short', date: '2026-09-01', transcriptSource: 'youtube', durationMin: 20 }),
      cand({ title: 'yt long', date: '2026-09-01', transcriptSource: 'youtube', durationMin: 90 }),
    ];
    expect(rankCandidates(cs).map((c) => c.title)).toEqual(['yt long', 'yt short', 'page', 'old', 'undated']);
  });
});

describe('discoverAppearances', () => {
  const reply = {
    candidates: [
      raw({ date: '2026-05-01', url: 'https://youtu.be/11111111111', title: 'Older talk' }),
      raw({ date: '2026-09-06', url: 'https://youtu.be/22222222222', title: 'Newest talk' }),
      raw({ date: '2026-07-01', url: 'https://example.com/already', title: 'Already pulled', transcript_source: 'page' }),
      raw({ date: '2026-08-01', url: 'https://youtu.be/33333333333', title: 'Middle talk' }),
    ],
  };

  test('one web-search call; prompt has name, today, since, limit and no ledger URL; have split; ranked; limit', async () => {
    const llm = new MockLLM(() => reply);
    const ledger = ledgerOf([makeClaim({ source: { title: 'x', url: 'https://www.example.com/already/', date: '2026-07-01', kind: 'podcast' } })]);
    const events: DiscoverEvent[] = [];
    const r = await discoverAppearances('  Jensen   Huang ', llm, { today: TODAY, limit: 2, ledger, onProgress: (e) => events.push(e) });
    expect(llm.calls).toHaveLength(1);
    const req = llm.calls[0]!;
    expect(req.schemaName).toBe('discover_appearances');
    expect(req.webSearch).toBe(true);
    expect(req.role).toBe('general');
    expect(req.variant).toBeUndefined();
    expect(req.system).toBe(DISCOVER_SYSTEM);
    expect(req.user).toBe(discoverUserPrompt('Jensen Huang', TODAY, SINCE, 2));
    expect(req.user).toContain('"Jensen Huang"');
    expect(req.user).toContain(TODAY);
    expect(req.user).toContain(SINCE);
    expect(req.user).toContain('at most 2');
    expect(req.user).not.toContain('example.com');
    expect(r.slug).toBe('jensen-huang');
    expect(r.since).toBe(SINCE);
    expect(r.candidates.map((c) => c.title)).toEqual(['Newest talk', 'Middle talk']);
    expect(r.have.map((c) => c.title)).toEqual(['Already pulled']);
    expect(r.dropped).toEqual([{ url: 'https://youtu.be/11111111111', reason: 'past the limit of 2' }]);
    expect(r.model).toBe('mock');
    expect(events.map((e) => e.stage)).toEqual(['searching', 'found', 'candidate', 'candidate', 'complete']);
    expect(events[0]!.message).toBe("Searching the web for Jensen Huang's recent interviews, podcasts and talks...");
    expect(events[1]!.message).toBe('Found 3 appearances. 1 already in your receipts.');
    expect(events[4]!.message).toBe('Done. Pick one to pull receipts from.');
  });

  test('limit clamps to 1..10; nothing new says since when', async () => {
    const empty = new MockLLM(() => ({ candidates: [] }));
    const events: DiscoverEvent[] = [];
    await discoverAppearances('Lisa Su', empty, { today: TODAY, limit: 50, onProgress: (e) => events.push(e) });
    expect(empty.calls[0]!.user).toContain('at most 10');
    expect(events.find((e) => e.stage === 'found')!.message).toBe('Found nothing new since Mar 31, 2026.');
    await discoverAppearances('Lisa Su', empty, { today: TODAY, limit: 0 });
    expect(empty.calls[1]!.user).toContain('at most 1 ');
  });

  test('"Still searching" fires while the call runs and stops after', async () => {
    const slow = new MockLLM(async () => {
      await Bun.sleep(35);
      return { candidates: [] };
    });
    const events: DiscoverEvent[] = [];
    await discoverAppearances('Lisa Su', slow, { today: TODAY, waitingEveryMs: 10, onProgress: (e) => events.push(e) });
    const waits = events.filter((e) => e.stage === 'waiting').length;
    expect(waits).toBeGreaterThanOrEqual(1);
    await Bun.sleep(30);
    expect(events.filter((e) => e.stage === 'waiting').length).toBe(waits);
    expect(events.find((e) => e.stage === 'waiting')!.message).toBe('Still searching (this can take up to a minute or two)...');
  });

  test('errors propagate and the timer is cleared', async () => {
    const failing = new MockLLM(() => {
      throw new Error('boom');
    });
    await expect(discoverAppearances('Lisa Su', failing, { today: TODAY, waitingEveryMs: 5 })).rejects.toThrow('boom');
  });

  test('dead links dropped when checkLinks is given', async () => {
    const llm = new MockLLM(() => reply);
    const fetched: string[] = [];
    const r = await discoverAppearances('Jensen Huang', llm, {
      today: TODAY,
      checkLinks: async (url) => {
        fetched.push(url);
        return new Response('', { status: url.includes('22222222222') ? 404 : 200 });
      },
    });
    expect(r.candidates.map((c) => c.title)).not.toContain('Newest talk');
    expect(r.dropped).toContainEqual({ url: 'https://youtu.be/22222222222', reason: 'the link is dead' });
    expect(fetched.some((u) => u.startsWith('https://www.youtube.com/oembed'))).toBe(true);
  });

  test('record through RecordingLLM, then replay the same person and today; another today misses', async () => {
    const fixtures = join(dir, 'fixtures');
    const live = new MockLLM(() => reply, { model: 'gpt-test', searched: () => [{ url: 'https://example.com/already' }] });
    const recorded = await discoverAppearances('Jensen Huang', new RecordingLLM(live, fixtures), { today: TODAY });
    expect(readdirSync(fixtures).some((f) => f.startsWith('discover_appearances-'))).toBe(true);
    const replayed = await discoverAppearances('Jensen Huang', new ReplayLLM(fixtures), { today: TODAY });
    expect(replayed.candidates).toEqual(recorded.candidates);
    expect(replayed.model.startsWith('replay:')).toBe(true);
    await expect(discoverAppearances('Jensen Huang', new ReplayLLM(fixtures), { today: '2026-09-28' })).rejects.toThrow(/No replay fixture/);
  });
});

describe('checkLink', () => {
  test('404/410 dead, 405 falls back to GET, network error unknown', async () => {
    expect(await checkLink('https://example.com/a', async () => new Response('', { status: 404 }))).toBe('dead');
    expect(await checkLink('https://example.com/a', async () => new Response('', { status: 410 }))).toBe('dead');
    const methods: string[] = [];
    const v = await checkLink('https://example.com/a', async (_u, init) => {
      methods.push(init?.method ?? 'GET');
      return new Response('ok', { status: init?.method === 'HEAD' ? 405 : 200 });
    });
    expect(v).toBe('ok');
    expect(methods).toEqual(['HEAD', 'GET']);
    expect(
      await checkLink('https://example.com/a', async () => {
        throw new Error('offline');
      }),
    ).toBe('unknown');
    expect(await checkLink('https://example.com/a', async () => new Response('', { status: 403 }))).toBe('unknown');
  });
});

describe('humanDate', () => {
  test('formats', () => {
    expect(humanDate('2026-03-31')).toBe('Mar 31, 2026');
    expect(humanDate('')).toBe('');
  });
});

describe('pullCandidate', () => {
  function setup(name: string) {
    const root = mkdtempSync(join(dir, `${name}-`));
    const cfg = configFromEnv({}, { root, ledgerPath: join(root, 'data', 'ledger.json'), today: TODAY, llmMode: 'replay' });
    return cfg;
  }
  const person = { name: 'Jensen Huang', slug: 'jensen-huang' };
  const yt = cand({
    title: 'AI factories',
    show: 'All-In',
    host: 'Jason Calacanis',
    date: '2026-09-06',
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    kind: 'interview',
    transcriptSource: 'youtube',
  });

  test('passes speaker, host, title, date, url, kind; status pulling then pulled with the count', async () => {
    const cfg = setup('ok');
    const store = discoveriesPath(cfg.ledgerPath);
    recordDiscovery(store, person.slug, { since: SINCE, candidates: [yt], have: new Set() });
    let seen: IngestRequest | undefined;
    let statusDuring = '';
    const events: IngestEvent[] = [];
    await pullCandidate(yt, person, {
      cfg,
      deps: defaultDeps(),
      maxMinutes: 20,
      send: (e) => events.push(e),
      run: async (req, _cfg, deps, send) => {
        seen = req;
        statusDuring = loadDiscoveries(store).bySlug[person.slug]!.candidates[0]!.status;
        expect(deps.loadTranscript).not.toBe(defaultDeps().loadTranscript);
        send({ stage: 'complete', message: 'Done: 7 new receipts for Jensen Huang.', count: 7 });
      },
    });
    expect(seen).toEqual({
      input: yt.url,
      speaker: 'Jensen Huang',
      host: 'Jason Calacanis',
      title: 'AI factories',
      date: '2026-09-06',
      url: yt.url,
      kind: 'interview',
    });
    expect(statusDuring).toBe('pulling');
    const after = loadDiscoveries(store).bySlug[person.slug]!.candidates[0]!;
    expect(after.status).toBe('pulled');
    expect(after.receipts).toBe(7);
    expect(after.pulledAt).toBeDefined();
    expect(events.map((e) => e.stage)).toEqual(['complete']);
  });

  test('an undated candidate sends no date; failure marks failed with a short error', async () => {
    const cfg = setup('fail');
    const store = discoveriesPath(cfg.ledgerPath);
    const undated = { ...yt, date: '' };
    recordDiscovery(store, person.slug, { since: SINCE, candidates: [undated], have: new Set() });
    let seen: IngestRequest | undefined;
    await pullCandidate(undated, person, {
      cfg,
      deps: defaultDeps(),
      send: () => {},
      run: async (req, _c, _d, send) => {
        seen = req;
        send({ stage: 'error', message: 'x'.repeat(500) });
      },
    });
    expect(seen && 'date' in seen).toBe(false);
    const after = loadDiscoveries(store).bySlug[person.slug]!.candidates[0]!;
    expect(after.status).toBe('failed');
    expect(after.error!.length).toBeLessThanOrEqual(200);
  });

  test('audio, unknown and private links are refused with an error event, never run', async () => {
    const cfg = setup('refuse');
    for (const c of [cand({ transcriptSource: 'audio' }), cand({ transcriptSource: 'unknown' }), cand({ url: 'http://127.0.0.1/x' })]) {
      const events: IngestEvent[] = [];
      let ran = false;
      await pullCandidate(c, person, {
        cfg,
        deps: defaultDeps(),
        send: (e) => events.push(e),
        run: async () => {
          ran = true;
        },
      });
      expect(ran).toBe(false);
      expect(events.map((e) => e.stage)).toEqual(['error']);
    }
  });

  test('a thrown run still ends as failed and sends an error', async () => {
    const cfg = setup('throw');
    const store = discoveriesPath(cfg.ledgerPath);
    recordDiscovery(store, person.slug, { since: SINCE, candidates: [yt], have: new Set() });
    const events: IngestEvent[] = [];
    await pullCandidate(yt, person, {
      cfg,
      deps: {} as ServerDeps,
      send: (e) => events.push(e),
      run: async () => {
        throw new Error('kaboom');
      },
    });
    expect(events).toEqual([{ stage: 'error', message: 'kaboom' }]);
    expect(loadDiscoveries(store).bySlug[person.slug]!.candidates[0]!.status).toBe('failed');
  });
});

describe('appLoadTranscript', () => {
  test('a cache hit makes no fetch; maxMinutes trims and says so', async () => {
    const root = mkdtempSync(join(dir, 'cache-'));
    const cfg = configFromEnv({}, { root, today: TODAY, llmMode: 'replay' });
    const url = 'https://example.com/transcript-page';
    const segments = Array.from({ length: 40 }, (_, i) => ({ start: i * 60, text: `Minute ${i} words.` }));
    writeCachedTranscript(transcriptCacheDir(cfg), url, { text: '', segments, meta: { title: 'Cached', durationSec: 2400, date: '2026-09-06' } });
    const lines: string[] = [];
    const load = appLoadTranscript(cfg, { maxMinutes: 5, onStatus: (m) => lines.push(m) });
    const t = await load(url, {
      fetch: async () => {
        throw new Error('network used');
      },
    });
    expect(t.segments).toHaveLength(5);
    expect(t.meta.durationSec).toBe(2400);
    expect(lines).toEqual(['Using the saved transcript.', 'Got the transcript: 40 min, said Sep 6, 2026. Using the first 5 minutes for a quick pull.']);
    expect(existsSync(transcriptCacheDir(cfg))).toBe(true);
  });

  test('a miss loads, caches the full transcript, then hits', async () => {
    const root = mkdtempSync(join(dir, 'cache2-'));
    const cfg = configFromEnv({}, { root, today: TODAY, llmMode: 'replay' });
    const lines: string[] = [];
    let fetches = 0;
    const body = Array.from({ length: 30 }, (_, i) => `[00:${String(i).padStart(2, '0')}:00] Speaker: line ${i} of the talk.`).join('\n');
    const doFetch = async () => {
      fetches++;
      return new Response(body, { headers: { 'content-type': 'text/plain' } });
    };
    const first = await appLoadTranscript(cfg, { maxMinutes: 10, onStatus: (m) => lines.push(m) })('https://example.com/t.txt', { fetch: doFetch });
    expect(first.segments).toHaveLength(10);
    expect(lines[0]).toBe('Reading the page...');
    const full = await appLoadTranscript(cfg)('https://example.com/t.txt', { fetch: doFetch });
    expect(full.segments).toHaveLength(30);
    expect(fetches).toBe(1);
  });
});
