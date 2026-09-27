// Transcript additions for discovery pulls: YouTube captions without yt-dlp,
// the fallback on a 429, the request gate, the transcript cache and the
// quick-pull trim. Offline (injected fetch, stand-in yt-dlp scripts).

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyMaxMinutes,
  captionTracksOf,
  isYtDlpBlocked,
  loadTranscript,
  loadYouTubeCaptions,
  pickCaptionTrack,
  playerResponseFromHtml,
  readCachedTranscript,
  transcriptCachePath,
  writeCachedTranscript,
  youtubeGate,
  youtubeVideoId,
} from '../src/transcript/load.ts';
import type { Transcript } from '../src/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'receipts-yt-fallback-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PLAYER = {
  videoDetails: { videoId: 'abcdefghijk', title: 'Synthetic keynote {with braces} "quoted"', author: 'Synthetic Channel', lengthSeconds: '3480' },
  microformat: { playerMicroformatRenderer: { publishDate: '2026-09-06T07:00:00-07:00' } },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=de', languageCode: 'de', name: { simpleText: 'German' } },
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&kind=asr', languageCode: 'en', kind: 'asr', name: { runs: [{ text: 'English (auto-generated)' }] } },
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en-GB', languageCode: 'en-GB', name: { simpleText: 'English (UK)' } },
      ],
    },
  },
};

// A hand-trimmed stand-in for a watch page: the player JSON sits inside a script with other braces around it.
const WATCH_HTML = `<!doctype html><html><head><script>var cfg = {a: {b: 1}};</script></head><body>
<script nonce="x">var ytInitialPlayerResponse = ${JSON.stringify(PLAYER)};var meta = {"x": "}"};</script>
</body></html>`;

const JSON3 = JSON.stringify({
  events: [
    { tStartMs: 0, segs: [{ utf8: 'We are building AI factories.' }] },
    { tStartMs: 1500, segs: [{ utf8: '\n' }] },
    { tStartMs: 4000, segs: [{ utf8: 'Every company will have one.' }] },
  ],
});

function fakeFetch(routes: (url: string) => Response) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    return routes(url);
  };
  return { fn, calls };
}

const okRoutes = (url: string) =>
  url.includes('/youtubei/v1/player')
    ? Response.json(PLAYER)
    : url.startsWith('https://www.youtube.com/watch')
      ? new Response(WATCH_HTML)
      : url.includes('timedtext')
        ? new Response(JSON3)
        : new Response('', { status: 404 });

describe('youtubeVideoId', () => {
  test('forms', () => {
    expect(youtubeVideoId('https://youtu.be/abcdefghijk')).toBe('abcdefghijk');
    expect(youtubeVideoId('https://www.youtube.com/live/abcdefghijk?si=1')).toBe('abcdefghijk');
    expect(youtubeVideoId('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(youtubeVideoId('https://example.com/watch?v=abcdefghijk')).toBeNull();
  });
});

describe('playerResponseFromHtml / captionTracksOf / pickCaptionTrack', () => {
  test('balanced-brace scan survives braces and quotes in strings', () => {
    const p = playerResponseFromHtml(WATCH_HTML);
    expect(p).toEqual(PLAYER);
    expect(playerResponseFromHtml('<html>no player</html>')).toBeNull();
    expect(playerResponseFromHtml('ytInitialPlayerResponse = {"a": ')).toBeNull();
  });

  test('tracks and the English pick: manual before asr', () => {
    const tracks = captionTracksOf(PLAYER);
    expect(tracks.map((t) => [t.languageCode, t.kind ?? null, t.name])).toEqual([
      ['de', null, 'German'],
      ['en', 'asr', 'English (auto-generated)'],
      ['en-GB', null, 'English (UK)'],
    ]);
    expect(pickCaptionTrack(tracks)!.languageCode).toBe('en-GB');
    expect(pickCaptionTrack(tracks.filter((t) => t.languageCode !== 'en-GB'))!.kind).toBe('asr');
    expect(pickCaptionTrack(tracks.slice(0, 1))).toBeNull();
    expect(captionTracksOf({})).toEqual([]);
    expect(captionTracksOf(null)).toEqual([]);
  });
});

describe('loadYouTubeCaptions', () => {
  test('app player API first: two requests', async () => {
    const { fn, calls } = fakeFetch(okRoutes);
    const r = await loadYouTubeCaptions('https://youtu.be/abcdefghijk', fn);
    expect(calls).toEqual(['https://www.youtube.com/youtubei/v1/player?prettyPrint=false', 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en-GB&fmt=json3']);
    expect(r.segments).toHaveLength(2);
    expect(r.meta.date).toBe('2026-09-06');
  });

  test('player API down: watch page -> json3 -> segments and meta', async () => {
    const { fn, calls } = fakeFetch((u) => (u.includes('/youtubei/') ? new Response('', { status: 500 }) : okRoutes(u)));
    const r = await loadYouTubeCaptions('https://youtu.be/abcdefghijk', fn);
    expect(calls[1]).toBe('https://www.youtube.com/watch?v=abcdefghijk&hl=en');
    expect(calls[2]).toBe('https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en-GB&fmt=json3');
    expect(r.segments).toEqual([
      { start: 0, text: 'We are building AI factories.' },
      { start: 4, text: 'Every company will have one.' },
    ]);
    expect(r.meta).toEqual({
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      kind: 'podcast',
      title: 'Synthetic keynote {with braces} "quoted"',
      channel: 'Synthetic Channel',
      durationSec: 3480,
      date: '2026-09-06',
    });
  });

  test('empty captions body (PO token wall) and no tracks are errors', async () => {
    const empty = fakeFetch((u) => (u.includes('timedtext') ? new Response('') : okRoutes(u)));
    await expect(loadYouTubeCaptions('https://youtu.be/abcdefghijk', empty.fn)).rejects.toThrow(/empty captions/);
    const none = fakeFetch(() => new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: {} })};</script>`));
    await expect(loadYouTubeCaptions('https://youtu.be/abcdefghijk', none.fn)).rejects.toThrow(/no English captions/);
  });
});

describe('yt-dlp fallback inside loadTranscript', () => {
  const rateLimited = join(dir, 'yt-dlp-429');
  writeFileSync(rateLimited, '#!/bin/sh\necho "ERROR: [youtube] abcdefghijk: Unable to download webpage: HTTP Error 429: Too Many Requests" >&2\nexit 1\n');
  chmodSync(rateLimited, 0o755);
  const unavailable = join(dir, 'yt-dlp-gone');
  writeFileSync(unavailable, '#!/bin/sh\necho "ERROR: Video unavailable" >&2\nexit 1\n');
  chmodSync(unavailable, 0o755);

  test('429 then the captions fallback succeeds, with a status line', async () => {
    const { fn } = fakeFetch(okRoutes);
    const status: string[] = [];
    const t = await loadTranscript('https://www.youtube.com/watch?v=abcdefghijk', { ytDlpBin: rateLimited, fetch: fn, youtubeGapMs: 0, onStatus: (m) => status.push(m) });
    expect(t.segments).toHaveLength(2);
    expect(t.meta.title).toBe('Synthetic keynote {with braces} "quoted"');
    expect(status).toEqual(['YouTube is busy, trying another way to get captions...']);
  });

  test('a missing yt-dlp also falls back', async () => {
    const { fn } = fakeFetch(okRoutes);
    const t = await loadTranscript('https://youtu.be/abcdefghijk', { ytDlpBin: 'yt-dlp-not-installed-receipts-test', fetch: fn, youtubeGapMs: 0 });
    expect(t.segments).toHaveLength(2);
  });

  test('fallback failure rethrows the original yt-dlp error', async () => {
    const { fn } = fakeFetch(() => new Response('', { status: 429 }));
    await expect(loadTranscript('https://youtu.be/abcdefghijk', { ytDlpBin: rateLimited, fetch: fn, youtubeGapMs: 0 })).rejects.toThrow(/yt-dlp failed \(exit 1\).*429/);
  });

  test('other yt-dlp errors do not fall back', async () => {
    const { fn, calls } = fakeFetch(okRoutes);
    await expect(loadTranscript('https://youtu.be/abcdefghijk', { ytDlpBin: unavailable, fetch: fn, youtubeGapMs: 0 })).rejects.toThrow(/Video unavailable/);
    expect(calls).toEqual([]);
  });

  test('isYtDlpBlocked', () => {
    expect(isYtDlpBlocked('yt-dlp failed (exit 1): ERROR: HTTP Error 429: Too Many Requests')).toBe(true);
    expect(isYtDlpBlocked("ERROR: Sign in to confirm you're not a bot")).toBe(true);
    expect(isYtDlpBlocked('ERROR: Video unavailable')).toBe(false);
  });
});

describe('youtubeGate', () => {
  test('waits out the gap between requests; 0 never waits', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    await youtubeGate(0, sleep);
    await youtubeGate(60_000, sleep);
    expect(waits).toHaveLength(1);
    expect(waits[0]!).toBeGreaterThan(59_000);
    await youtubeGate(0, sleep);
    expect(waits).toHaveLength(1);
  });
});

describe('transcript cache', () => {
  const t: Transcript = { text: '', segments: [{ start: 0, text: 'Hello there.' }], meta: { title: 'Cached talk', durationSec: 60 } };

  test('round trip; YouTube forms share one file', () => {
    const cache = join(dir, 'cache');
    writeCachedTranscript(cache, 'https://youtu.be/abcdefghijk', t);
    expect(transcriptCachePath(cache, 'https://www.youtube.com/watch?v=abcdefghijk&t=5s')).toBe(transcriptCachePath(cache, 'https://youtu.be/abcdefghijk'));
    const back = readCachedTranscript(cache, 'https://www.youtube.com/watch?v=abcdefghijk');
    expect(back).toEqual({ text: 'Hello there.', segments: t.segments, meta: t.meta });
    expect(readCachedTranscript(cache, 'https://example.com/other')).toBeNull();
    expect(transcriptCachePath(cache, 'https://example.com/x').endsWith('.json')).toBe(true);
  });

  test('loadTranscript with cacheDir: a hit makes no request; explicit options still win', async () => {
    const cache = join(dir, 'cache-hit');
    writeCachedTranscript(cache, 'https://youtu.be/abcdefghijk', t);
    const status: string[] = [];
    const loaded = await loadTranscript('https://youtu.be/abcdefghijk', { cacheDir: cache, ytDlpBin: '/nonexistent', title: 'Given title', onStatus: (m) => status.push(m) });
    expect(loaded.meta.title).toBe('Given title');
    expect(loaded.text).toBe('Hello there.');
    expect(status).toEqual(['Using the saved transcript.']);
  });
});

describe('applyMaxMinutes', () => {
  const timed: Transcript = {
    text: '',
    segments: Array.from({ length: 10 }, (_, i) => ({ start: i * 120, text: `part ${i}` })),
    meta: { durationSec: 1200 },
  };

  test('timed: keeps segments starting before the cut, text rebuilt, meta kept', () => {
    const { transcript, trimmed } = applyMaxMinutes(timed, 5);
    expect(trimmed).toBe(true);
    expect(transcript.segments.map((s) => s.text)).toEqual(['part 0', 'part 1', 'part 2']);
    expect(transcript.text).toBe('part 0\npart 1\npart 2');
    expect(transcript.meta.durationSec).toBe(1200);
  });

  test('no-op when shorter', () => {
    const r = applyMaxMinutes(timed, 60);
    expect(r.trimmed).toBe(false);
    expect(r.transcript).toBe(timed);
  });

  test('untimed: about 900 characters a minute, cut at a word', () => {
    const words = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(' ');
    const untimed: Transcript = { text: words, segments: [{ text: words }], meta: {} };
    const { transcript, trimmed } = applyMaxMinutes(untimed, 1);
    expect(trimmed).toBe(true);
    expect(transcript.text.length).toBeLessThanOrEqual(900);
    expect(transcript.text.length).toBeGreaterThan(800);
    expect(transcript.text.endsWith(' ')).toBe(false);
    expect(words.startsWith(transcript.text)).toBe(true);
  });

  test('loadTranscript maxMinutes trims after loading', async () => {
    const file = join(dir, 'talk.txt');
    writeFileSync(file, Array.from({ length: 10 }, (_, i) => `[00:0${i}:00] Host: line ${i}`).join('\n'));
    const t = await loadTranscript(file, { maxMinutes: 3 });
    expect(t.segments).toHaveLength(3);
  });
});
