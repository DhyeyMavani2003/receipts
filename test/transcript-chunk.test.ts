import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { buildText, chunkTranscript, segmentAtChar, startSecAtChar, textLayout } from '../src/transcript/chunk.ts';
import { loadTranscript } from '../src/transcript/load.ts';
import type { Segment, Transcript } from '../src/types.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'transcripts');

function transcriptOf(segments: Segment[]): Transcript {
  return { text: buildText(segments).text, segments, meta: {} };
}

const segments: Segment[] = [
  { start: 0, speaker: 'Sam Host', text: 'Will you ship?' },
  { start: 5, speaker: 'Dana Founder', text: 'We will ship ten thousand robots.' },
  { text: 'A paragraph with no time of its own.', speaker: 'Dana Founder' },
  { start: 20, text: 'Unlabeled caption line.' },
];

describe('buildText', () => {
  test('one line per segment, speaker label on every labeled line', () => {
    const { text } = buildText(segments);
    expect(text.split('\n')).toEqual([
      'Sam Host: Will you ship?',
      'Dana Founder: We will ship ten thousand robots.',
      'Dana Founder: A paragraph with no time of its own.',
      'Unlabeled caption line.',
    ]);
  });

  test('offsets point at line starts, textStarts at the words', () => {
    const { text, offsets, textStarts } = buildText(segments);
    segments.forEach((seg, i) => {
      expect(text.slice(textStarts[i]!, textStarts[i]! + seg.text.length)).toBe(seg.text);
      expect(offsets[i]! === 0 || text[offsets[i]! - 1] === '\n').toBe(true);
    });
  });

  test('empty input', () => {
    expect(buildText([])).toEqual({ text: '', offsets: [], textStarts: [] });
  });
});

describe('segmentAtChar / startSecAtChar', () => {
  const t = transcriptOf(segments);

  test('maps every char of a line (label included) to its segment', () => {
    const { offsets } = buildText(segments);
    for (let i = 0; i < segments.length; i++) {
      const end = (offsets[i + 1] ?? t.text.length + 1) - 1;
      for (let c = offsets[i]!; c < end; c++) expect(segmentAtChar(t, c)).toBe(segments[i]);
    }
  });

  test('out of range -> undefined', () => {
    expect(segmentAtChar(t, -1)).toBeUndefined();
    expect(segmentAtChar(t, t.text.length)).toBeUndefined();
    expect(segmentAtChar(t, Number.NaN)).toBeUndefined();
  });

  test('a segment without a start inherits the previous start', () => {
    const at = t.text.indexOf('A paragraph');
    expect(startSecAtChar(t, at)).toBe(5);
    expect(startSecAtChar(t, t.text.indexOf('Unlabeled'))).toBe(20);
  });

  test('transcripts not built by buildText are located by search', () => {
    const plain: Transcript = {
      text: 'intro\nfirst line\nsecond line',
      segments: [{ start: 1, text: 'first line' }, { start: 9, text: 'second line' }],
      meta: {},
    };
    expect(textLayout(plain).offsets).toEqual([0, 17]);
    expect(segmentAtChar(plain, plain.text.indexOf('second'))?.start).toBe(9);
    expect(startSecAtChar(plain, plain.text.indexOf('first'))).toBe(1);
  });
});

describe('chunkTranscript', () => {
  function assertCovers(t: Transcript, maxChars: number, overlap: number) {
    const chunks = chunkTranscript(t, maxChars, overlap);
    expect(chunks[0]!.startChar).toBe(0);
    expect(chunks.at(-1)!.endChar).toBe(t.text.length);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.text).toBe(t.text.slice(c.startChar, c.endChar));
      expect(c.endChar - c.startChar).toBeLessThanOrEqual(maxChars);
      const next = chunks[i + 1];
      if (next) {
        expect(next.startChar).toBeGreaterThan(c.startChar);
        expect(next.startChar).toBeLessThanOrEqual(c.endChar + 1); // no gap beyond a separator
        expect(c.endChar - next.startChar).toBeLessThanOrEqual(overlap);
      }
    });
    return chunks;
  }

  test('short transcript -> one chunk', () => {
    const t = transcriptOf(segments);
    const chunks = chunkTranscript(t);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, startChar: 0, endChar: t.text.length, startSec: 0 });
  });

  test('empty transcript -> no chunks', () => {
    expect(chunkTranscript(transcriptOf([]))).toEqual([]);
  });

  test('covers the fixture with bounded overlap and cuts at line starts', async () => {
    const t = await loadTranscript(join(FIXTURES, 'synthetic-interview.txt'));
    const chunks = assertCovers(t, 2000, 300);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks.slice(1)) {
      expect(t.text[c.startChar - 1]).toMatch(/\n| /);
      expect(c.startSec).toBeNumber();
    }
    // Most windows start on a speaker label, so attribution survives chunking.
    const labeled = chunks.filter((c) => /^(Sam Host|Dana Founder): /.test(c.text)).length;
    expect(labeled / chunks.length).toBeGreaterThan(0.5);
  });

  test('works on caption-sized lines, tiny windows and no overlap', async () => {
    const t = await loadTranscript(join(FIXTURES, 'synthetic-youtube.en.vtt'));
    assertCovers(t, 120, 40);
    assertCovers(t, 50, 0);
    assertCovers(t, 7, 3);
  });

  test('a single long line is cut at spaces', () => {
    const t = transcriptOf([{ text: 'word '.repeat(500).trim() }]);
    const chunks = assertCovers(t, 100, 20);
    for (const c of chunks) expect(c.text.startsWith('word')).toBe(true);
  });

  test('rejects a non-positive window', () => {
    expect(() => chunkTranscript(transcriptOf(segments), 0)).toThrow(RangeError);
  });
});
