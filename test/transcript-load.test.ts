import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LLMUnavailableError } from '../src/llm/provider.ts';
import {
  decodeEntities,
  htmlTitle,
  htmlToText,
  isYouTubeUrl,
  loadTranscript,
  mapYtDlpMeta,
  parseClock,
  parseJsonTranscript,
  parsePlain,
  parseSrt,
  parseVtt,
  pickSubtitleFile,
  transcribeAudio,
  ytDlpArgs,
} from '../src/transcript/load.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'transcripts');
const VTT_FIXTURE = join(FIXTURES, 'synthetic-youtube.en.vtt');
const INTERVIEW_FIXTURE = join(FIXTURES, 'synthetic-interview.txt');

const dir = mkdtempSync(join(tmpdir(), 'receipts-transcript-load-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type FetchCall = { url: string; init?: RequestInit };
function fakeFetch(respond: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fn, calls };
}

describe('fixtures', () => {
  test('first line of every synthetic fixture says it is synthetic', () => {
    for (const file of [VTT_FIXTURE, INTERVIEW_FIXTURE]) {
      expect(readFileSync(file, 'utf8').split('\n')[0]).toMatch(/SYNTHETIC TEST DATA/);
    }
  });
});

describe('parseClock', () => {
  test.each([
    ['00:00:01.234', 1.234],
    ['01:02:03', 3723],
    ['1:02:03,5', 3723.5],
    ['02:03', 123],
    ['125:00:00', 450000],
  ])('%p -> %p', (s, sec) => expect(parseClock(s)).toBe(sec));

  test.each(['', '1:2', '00:61', '00:60:00', 'ab:cd'])('%p -> undefined', (s) => expect(parseClock(s)).toBeUndefined());
});

describe('parseVtt', () => {
  const segments = parseVtt(readFileSync(VTT_FIXTURE, 'utf8'));

  test('YouTube rolling captions come out once each, clean, in time order', () => {
    expect(segments).toHaveLength(20);
    expect(segments[0]).toEqual({ start: 0.03, text: 'welcome back everyone this is the' });
    expect(segments[1]!.text).toBe("Ferrowind keynote and I'm Dana");
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.text).not.toBe(segments[i - 1]!.text);
      expect(segments[i]!.start!).toBeGreaterThan(segments[i - 1]!.start!);
    }
    for (const seg of segments) expect(seg.text).not.toMatch(/[<>]|\[Music\]|^\s|\s$/);
  });

  test('non-speech tags removed, filler kept verbatim', () => {
    expect(segments.map((s) => s.text)).toContain('on existing customers ever');
    expect(segments.map((s) => s.text)).toContain('um so first the numbers');
  });

  test('voice tags, entities, identifiers, NOTE and STYLE blocks', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE this is a comment',
      'that spans two lines',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      'intro-1',
      '00:01.000 --> 00:04.000',
      '<v Dana Founder>We&#39;ll ship &amp; scale.</v>',
      '',
      '00:04.000 --> 00:06.000 line:0',
      '&gt;&gt; <i>Next</i> question.',
    ].join('\r\n');
    expect(parseVtt(vtt)).toEqual([
      { start: 1, text: "We'll ship & scale.", speaker: 'Dana Founder' },
      { start: 4, text: 'Next question.' },
    ]);
  });

  test('word-by-word growing lines collapse into the longest one', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nwe will\n\n00:00:02.000 --> 00:00:03.000\nwe will ship\n\n00:00:03.000 --> 00:00:04.000\nnext year';
    expect(parseVtt(vtt)).toEqual([
      { start: 1, text: 'we will ship' },
      { start: 3, text: 'next year' },
    ]);
  });

  test('empty or header-only input', () => {
    expect(parseVtt('')).toEqual([]);
    expect(parseVtt('WEBVTT\n\n')).toEqual([]);
  });

  test('a <v> voice covers every following line of its cue, until </v>', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:05.000',
      '<v Sam Host>So tell me about the plan.',
      'We will ship ten thousand robots by the end of 2025.',
      '',
      '00:00:05.000 --> 00:00:09.000',
      '<v Dana Founder>Quality comes first.</v>',
      'Unvoiced narration.',
    ].join('\n');
    expect(parseVtt(vtt)).toEqual([
      { start: 1, text: 'So tell me about the plan.', speaker: 'Sam Host' },
      { start: 1, text: 'We will ship ten thousand robots by the end of 2025.', speaker: 'Sam Host' },
      { start: 5, text: 'Quality comes first.', speaker: 'Dana Founder' },
      { start: 5, text: 'Unvoiced narration.' },
    ]);
  });
});

describe('parseSrt', () => {
  test('index lines, comma times, multi-line cues, markup', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:03,500',
      '<i>We will ship</i>',
      'ten thousand robots.',
      '',
      '2',
      '00:00:03,500 --> 00:00:05,000',
      '{\\an8}For sure.',
      '',
    ].join('\n');
    expect(parseSrt(srt)).toEqual([
      { start: 1, text: 'We will ship ten thousand robots.' },
      { start: 3.5, text: 'For sure.' },
    ]);
  });

  test('recurring "Name:" labels become speakers, a one-off "Look:" does not', () => {
    const srt = [
      '1\n00:00:01,000 --> 00:00:02,000\nSAM: Will you ship?',
      '2\n00:00:02,000 --> 00:00:03,000\nDANA: Yes.',
      '3\n00:00:03,000 --> 00:00:04,000\nSAM: When?',
      '4\n00:00:04,000 --> 00:00:05,000\nDANA: Look: next year.',
    ].join('\n\n');
    expect(parseSrt(srt)).toEqual([
      { start: 1, text: 'Will you ship?', speaker: 'SAM' },
      { start: 2, text: 'Yes.', speaker: 'DANA' },
      { start: 3, text: 'When?', speaker: 'SAM' },
      { start: 4, text: 'Look: next year.', speaker: 'DANA' },
    ]);
  });
});

describe('parsePlain', () => {
  test.each([
    ['[00:01:02] We will ship.', { start: 62, text: 'We will ship.' }],
    ['[01:02] Dana Founder: We will ship.', { start: 62, speaker: 'Dana Founder', text: 'We will ship.' }],
    ['(00:01:02) We will ship.', { start: 62, text: 'We will ship.' }],
    ['Lex Fridman (00:01:02) What is AGI?', { start: 62, speaker: 'Lex Fridman', text: 'What is AGI?' }],
    ['Dana Founder [1:01:02]: We will ship.', { start: 3662, speaker: 'Dana Founder', text: 'We will ship.' }],
    ['00:01:02 Dana Founder: We will ship.', { start: 62, speaker: 'Dana Founder', text: 'We will ship.' }],
    ['01:02 - Dana: We will ship.', { start: 62, speaker: 'Dana', text: 'We will ship.' }],
    ['00:01:02 We will ship.', { start: 62, text: 'We will ship.' }],
  ])('%p', (line, expected) => {
    expect(parsePlain(line)).toEqual([expected]);
  });

  test('"Name: text" is a label only in labeled dialogue; prose times are not headers', () => {
    const s = 'Important: this is prose.\n\n10:30 is when we met.\n\nSam: Hi.\nDana: Hello.\nSam: Bye.';
    expect(parsePlain(s)).toEqual([
      { text: 'Important: this is prose.' },
      { text: '10:30 is when we met.' },
      { speaker: 'Sam', text: 'Hi.' },
      { speaker: 'Dana', text: 'Hello.' },
      { speaker: 'Sam', text: 'Bye.' },
    ]);
  });

  test('header line followed by text lines and paragraphs (Otter style)', () => {
    const s = 'Sam Host  0:03\nWill you ship\nthis year?\n\nDana Founder  0:07\n\nYes.\n\nTen thousand, for sure.';
    expect(parsePlain(s)).toEqual([
      { start: 3, speaker: 'Sam Host', text: 'Will you ship this year?' },
      { start: 7, speaker: 'Dana Founder', text: 'Yes.' },
      { speaker: 'Dana Founder', text: 'Ten thousand, for sure.' },
    ]);
  });

  test('prose: one segment per paragraph, wrapped lines joined', () => {
    expect(parsePlain('First line\nwrapped.\n\n\nSecond   paragraph.\r\n')).toEqual([
      { text: 'First line wrapped.' },
      { text: 'Second paragraph.' },
    ]);
  });

  test('the synthetic interview fixture', () => {
    const segments = parsePlain(readFileSync(INTERVIEW_FIXTURE, 'utf8'));
    const [notice, ...turns] = segments;
    expect(notice!.text).toMatch(/^SYNTHETIC TEST DATA/);
    expect(notice!.speaker).toBeUndefined();
    expect(new Set(turns.map((s) => s.speaker))).toEqual(new Set(['Sam Host', 'Dana Founder']));
    expect(turns.length).toBeGreaterThan(60);
    for (let i = 1; i < turns.length; i++) expect(turns[i]!.start!).toBeGreaterThan(turns[i - 1]!.start!);
    const words = turns.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
    expect(words).toBeGreaterThan(2200);
  });
});

describe('htmlToText / htmlTitle / decodeEntities', () => {
  const html = `<!doctype html><html><head><title>Episode 12 &amp; more</title>
    <meta property="og:title" content="Episode 12: Robots">
    <style>p { color: red }</style></head>
    <body><nav><a href="/">Home</a></nav><header><h1>Site header</h1></header>
    <article><h1>Episode 12</h1><p>We will ship <b>ten&nbsp;thousand</b> robots.</p>
    <p>Second&#8217;s paragraph<br>new line &#x2014; dash</p><!-- hidden --><script>alert("x")</script>
    <ul><li>One</li><li>Two</li></ul></article><footer>Copyright</footer></body></html>`;

  test('keeps paragraphs, drops boilerplate', () => {
    expect(htmlToText(html)).toBe(
      'Episode 12\n\nWe will ship ten thousand robots.\n\nSecond’s paragraph\nnew line — dash\n\nOne\n\nTwo',
    );
  });

  test('title prefers og:title', () => {
    expect(htmlTitle(html)).toBe('Episode 12: Robots');
    expect(htmlTitle('<title> A &amp; B </title>')).toBe('A & B');
    expect(htmlTitle('<p>none</p>')).toBeUndefined();
  });

  test('entities', () => {
    expect(decodeEntities('&lt;a&gt; &quot;x&quot; &#39;y&#39; &#x41; &bogus; &#0;')).toBe('<a> "x" \'y\' A &bogus; &#0;');
  });
});

describe('parseJsonTranscript', () => {
  test('{segments} with speakers and clock strings', () => {
    const json = JSON.stringify({ segments: [{ start: 1.5, text: ' Hi. ', speaker: 'Sam' }, { start: '00:01:02', text: 'Yes.' }, { text: '' }] });
    expect(parseJsonTranscript(json)).toEqual([
      { start: 1.5, text: 'Hi.', speaker: 'Sam' },
      { start: 62, text: 'Yes.' },
    ]);
  });

  test('bare array and Whisper verbose_json', () => {
    expect(parseJsonTranscript('[{"text":"a"}]')).toEqual([{ text: 'a' }]);
    const whisper = { text: 'We will ship.', segments: [{ id: 0, start: 0, end: 2.1, text: ' We will ship.' }] };
    expect(parseJsonTranscript(JSON.stringify(whisper))).toEqual([{ start: 0, text: 'We will ship.' }]);
  });

  test('yt-dlp json3', () => {
    const json3 = {
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'we' }, { utf8: ' will', tOffsetMs: 400 }] },
        { tStartMs: 1900, aAppend: 1, segs: [{ utf8: '\n' }] },
        { tStartMs: 2000, segs: [{ utf8: 'ship &gt;&gt; ' }, { utf8: '[Music]' }] },
        { tStartMs: 3000 },
      ],
    };
    expect(parseJsonTranscript(JSON.stringify(json3))).toEqual([
      { start: 0, text: 'we will' },
      { start: 2, text: 'ship' },
    ]);
  });

  test('unknown shape', () => {
    expect(() => parseJsonTranscript('{"foo":1}')).toThrow(/Unrecognized JSON transcript/);
  });
});

describe('YouTube helpers', () => {
  test('isYouTubeUrl', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isYouTubeUrl('https://youtu.be/abc')).toBe(true);
    expect(isYouTubeUrl('https://m.youtube.com/watch?v=abc')).toBe(true);
    expect(isYouTubeUrl('https://notyoutube.com/watch?v=abc')).toBe(false);
    expect(isYouTubeUrl('fixtures/x.vtt')).toBe(false);
  });

  test('ytDlpArgs: subtitles and metadata only, argv array, URL last', () => {
    expect(ytDlpArgs('https://youtu.be/abc', '/tmp/x')).toEqual([
      'yt-dlp',
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'en.*,en',
      '--sub-format',
      'vtt',
      '--no-playlist',
      '--print-json',
      '-o',
      '/tmp/x/%(id)s',
      'https://youtu.be/abc',
    ]);
    expect(ytDlpArgs('https://youtu.be/abc', '/tmp/x', '/opt/yt-dlp')[0]).toBe('/opt/yt-dlp');
  });

  test('mapYtDlpMeta', () => {
    const json = {
      id: 'abc123',
      title: 'Synthetic keynote',
      webpage_url: 'https://www.youtube.com/watch?v=abc123',
      original_url: 'https://youtu.be/abc123',
      upload_date: '20250115',
      channel: 'Synthetic Channel',
      uploader: 'Someone',
      duration: 3725,
      formats: [{}],
    };
    expect(mapYtDlpMeta(json)).toEqual({
      id: 'abc123',
      title: 'Synthetic keynote',
      url: 'https://www.youtube.com/watch?v=abc123',
      date: '2025-01-15',
      channel: 'Synthetic Channel',
      durationSec: 3725,
    });
    expect(mapYtDlpMeta({ uploader: 'U', timestamp: 1736899200, original_url: 'https://youtu.be/x' })).toEqual({
      url: 'https://youtu.be/x',
      date: '2025-01-15',
      channel: 'U',
    });
    expect(mapYtDlpMeta({ upload_date: 'garbage', duration: 'long' })).toEqual({});
    expect(mapYtDlpMeta(null)).toEqual({});
    expect(mapYtDlpMeta([1, 2])).toEqual({});
  });

  test('pickSubtitleFile prefers plain English', () => {
    expect(pickSubtitleFile(['abc.en-orig.vtt', 'abc.en.vtt', 'abc.de.vtt'], 'abc')).toBe('abc.en.vtt');
    expect(pickSubtitleFile(['abc.en-orig.vtt', 'abc.en-GB.vtt'], 'abc')).toBe('abc.en-GB.vtt');
    expect(pickSubtitleFile(['abc.en-orig.vtt', 'abc.en-uYU-mmqFLq8.vtt'])).toBe('abc.en-uYU-mmqFLq8.vtt');
    expect(pickSubtitleFile(['other.en.vtt', 'abc.info.json'], 'abc')).toBeUndefined();
    expect(pickSubtitleFile([])).toBeUndefined();
  });
});

describe('loadTranscript', () => {
  test('local .txt: segments, text layout and meta; options win', async () => {
    const t = await loadTranscript(INTERVIEW_FIXTURE, { date: '2025-01-15', url: 'https://example.com/ep42', title: 'The Build Log #42' });
    expect(t.meta).toEqual({ title: 'The Build Log #42', url: 'https://example.com/ep42', date: '2025-01-15', kind: 'podcast' });
    expect(t.text.split('\n')).toHaveLength(t.segments.length);
    expect(t.text).toContain('\nDana Founder: We build general-purpose humanoid robots.');
  });

  test('local .vtt defaults the title to the file name', async () => {
    const t = await loadTranscript(VTT_FIXTURE, { kind: 'keynote' });
    expect(t.meta).toEqual({ title: 'synthetic-youtube.en', kind: 'keynote' });
    expect(t.segments).toHaveLength(20);
  });

  test('local .srt, .json and .html', async () => {
    const srt = join(dir, 'a.srt');
    writeFileSync(srt, '1\n00:00:01,000 --> 00:00:02,000\nHello.\n');
    expect((await loadTranscript(srt)).text).toBe('Hello.');
    const json = join(dir, 'b.json');
    writeFileSync(json, JSON.stringify({ segments: [{ start: 0, text: 'Hi.', speaker: 'Sam' }] }));
    expect((await loadTranscript(json)).text).toBe('Sam: Hi.');
    const html = join(dir, 'c.html');
    writeFileSync(html, '<title>Post</title><p>One.</p><p>Two.</p>');
    const page = await loadTranscript(html);
    expect(page.text).toBe('One.\nTwo.');
    expect(page.meta).toMatchObject({ title: 'Post', kind: 'article' });
  });

  test('clear errors: missing file, bad date, empty transcript', async () => {
    await expect(loadTranscript(join(dir, 'nope.txt'))).rejects.toThrow(/No such file/);
    await expect(loadTranscript(INTERVIEW_FIXTURE, { date: 'Jan 15' })).rejects.toThrow(/YYYY-MM-DD/);
    const empty = join(dir, 'empty.txt');
    writeFileSync(empty, '\n\n');
    await expect(loadTranscript(empty)).rejects.toThrow(/No transcript text/);
  });

  test('web page: fetch -> htmlToText -> parsePlain', async () => {
    const { fn, calls } = fakeFetch(
      () => new Response('<html><title>Talk</title><p>Sam: Hi.</p><p>Dana: We will ship.</p><p>Sam: Thanks.</p><p>Dana: Bye.</p></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const t = await loadTranscript('https://example.com/talk', { fetch: fn, date: '2025-02-01' });
    expect(calls[0]!.url).toBe('https://example.com/talk');
    expect(t.meta).toEqual({ url: 'https://example.com/talk', kind: 'article', title: 'Talk', date: '2025-02-01' });
    expect(t.segments[1]).toEqual({ speaker: 'Dana', text: 'We will ship.' });
  });

  test('web .vtt and HTTP errors', async () => {
    const vtt = readFileSync(VTT_FIXTURE, 'utf8');
    const ok = fakeFetch(() => new Response(vtt, { headers: { 'content-type': 'text/plain' } }));
    expect((await loadTranscript('https://example.com/captions.vtt', { fetch: ok.fn })).segments).toHaveLength(20);
    const notFound = fakeFetch(() => new Response('gone', { status: 404 }));
    await expect(loadTranscript('https://example.com/x', { fetch: notFound.fn })).rejects.toThrow(/HTTP 404/);
  });

  test('YouTube without yt-dlp: install hint', async () => {
    await expect(
      loadTranscript('https://www.youtube.com/watch?v=abc', { ytDlpBin: 'yt-dlp-not-installed-receipts-test' }),
    ).rejects.toThrow(/brew install yt-dlp/);
  });

  test('YouTube through a stand-in yt-dlp: spawn, subtitle pick, meta', async () => {
    const fake = join(dir, 'fake-yt-dlp');
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'out=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done',
        'dir=$(dirname "$out")',
        `cp '${VTT_FIXTURE}' "$dir/SYNTH1.en-orig.vtt"`,
        `cp '${VTT_FIXTURE}' "$dir/SYNTH1.en.vtt"`,
        'echo "[info] writing subtitles"',
        `echo '{"id":"SYNTH1","title":"Synthetic keynote","webpage_url":"https://www.youtube.com/watch?v=SYNTH1","upload_date":"20250115","channel":"Synthetic Channel","duration":61}'`,
      ].join('\n'),
    );
    chmodSync(fake, 0o755);
    const t = await loadTranscript('https://youtu.be/SYNTH1', { ytDlpBin: fake });
    expect(t.meta).toEqual({
      title: 'Synthetic keynote',
      url: 'https://www.youtube.com/watch?v=SYNTH1',
      date: '2025-01-15',
      channel: 'Synthetic Channel',
      durationSec: 61,
      kind: 'podcast',
    });
    expect(t.segments).toHaveLength(20);
  });

  test('YouTube: yt-dlp failure surfaces stderr', async () => {
    const failing = join(dir, 'failing-yt-dlp');
    writeFileSync(failing, '#!/bin/sh\necho "ERROR: Video unavailable" >&2\nexit 1\n');
    chmodSync(failing, 0o755);
    await expect(loadTranscript('https://youtu.be/gone', { ytDlpBin: failing })).rejects.toThrow(/exit 1.*Video unavailable/);
  });
});

describe('transcribeAudio', () => {
  const audio = join(dir, 'clip.mp3');
  writeFileSync(audio, 'ID3 not really audio');

  test('posts whisper-1 verbose_json multipart and maps segments', async () => {
    const { fn, calls } = fakeFetch(
      () => Response.json({ text: 'We will ship.', segments: [{ start: 0, end: 1, text: ' We will ship.' }, { start: 1.5, end: 3, text: ' For sure.' }] }),
    );
    const t = await loadTranscript(audio, { fetch: fn, openaiKey: 'test-key' });
    expect(t.segments).toEqual([
      { start: 0, text: 'We will ship.' },
      { start: 1.5, text: 'For sure.' },
    ]);
    expect(t.meta).toEqual({ title: 'clip', kind: 'podcast' });
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect((form.get('file') as File).name).toBe('clip.mp3');
  });

  test('falls back to the plain text when there are no segments', async () => {
    const { fn } = fakeFetch(() => Response.json({ text: ' Hello there. ' }));
    expect(await transcribeAudio(audio, { fetch: fn, apiKey: 'test-key' })).toEqual([{ start: 0, text: 'Hello there.' }]);
  });

  test('errors: missing key, rejected key, other HTTP errors with the key redacted', async () => {
    const never = fakeFetch(() => {
      throw new Error('must not be called');
    });
    await expect(transcribeAudio(audio, { fetch: never.fn, apiKey: '' })).rejects.toBeInstanceOf(LLMUnavailableError);
    const unauthorized = fakeFetch(() => new Response('{}', { status: 401 }));
    await expect(transcribeAudio(audio, { fetch: unauthorized.fn, apiKey: 'test-key' })).rejects.toThrow(/OPENAI_API_KEY rejected/);
    const leaky = fakeFetch(() => new Response('bad key sk-abcdefghijklmnop123', { status: 500 }));
    const err = await transcribeAudio(audio, { fetch: leaky.fn, apiKey: 'test-key' }).catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 500/);
    expect(String(err)).not.toContain('sk-abcdefghijklmnop123');
  });

  test('files over 25 MB are refused before any upload', async () => {
    const big = join(dir, 'big.m4a');
    writeFileSync(big, '');
    truncateSync(big, 26 * 1024 * 1024);
    const never = fakeFetch(() => {
      throw new Error('must not be called');
    });
    await expect(transcribeAudio(big, { fetch: never.fn, apiKey: 'test-key' })).rejects.toThrow(/26\.0 MB.*at most 25 MB/);
  });
});
