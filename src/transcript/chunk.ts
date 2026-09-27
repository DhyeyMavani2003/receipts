// Transcript text layout and chunking. Transcript.text is built from the
// segments by buildText(), so any char offset maps back to its segment and
// from there to a timestamp. Extraction windows (chunkTranscript) and quote
// matching (quote-check.ts) both rely on that mapping.

import type { Segment, Transcript } from '../types.ts';

export interface Chunk {
  index: number;
  text: string;
  startChar: number;
  endChar: number;
  startSec?: number;
}

export interface TextLayout {
  text: string;
  /** offsets[i]: char index where segment i's line starts (at its speaker label, if any). */
  offsets: number[];
  /** textStarts[i]: char index where segment i's own words start, after the label. */
  textStarts: number[];
}

/** "Dana Founder: " for a segment with a speaker, else "". */
export function speakerLabel(seg: Segment): string {
  const name = seg.speaker?.trim();
  return name ? `${name}: ` : '';
}

/**
 * One line per segment, joined with "\n". Every line carries its speaker
 * label so the extractor can tell the guest's words from the host's in any
 * chunk, however it is cut.
 */
export function buildText(segments: readonly Segment[]): TextLayout {
  const lines: string[] = [];
  const offsets: number[] = [];
  const textStarts: number[] = [];
  let pos = 0;
  for (const seg of segments) {
    const label = speakerLabel(seg);
    const line = label + seg.text;
    offsets.push(pos);
    textStarts.push(pos + label.length);
    lines.push(line);
    pos += line.length + 1;
  }
  return { text: lines.join('\n'), offsets, textStarts };
}

// Transcripts put together by hand (tests, other tools) may not use
// buildText(); find each segment's words in order instead.
function locateSegments(t: Transcript): TextLayout {
  const offsets: number[] = [];
  let cursor = 0;
  for (const seg of t.segments) {
    const at = seg.text ? t.text.indexOf(seg.text, cursor) : -1;
    offsets.push(offsets.length === 0 ? 0 : at >= 0 ? at : cursor);
    if (at >= 0) cursor = at + seg.text.length;
  }
  return { text: t.text, offsets, textStarts: [...offsets] };
}

const layoutCache = new WeakMap<Transcript, TextLayout>();

/** Segment offsets for `t`, cached per transcript object. */
export function textLayout(t: Transcript): TextLayout {
  const cached = layoutCache.get(t);
  if (cached && cached.text === t.text && cached.offsets.length === t.segments.length) return cached;
  const built = buildText(t.segments);
  const layout = built.text === t.text ? built : locateSegments(t);
  layoutCache.set(t, layout);
  return layout;
}

/** Index of the last segment whose line starts at or before `charOffset`; -1 if none. */
export function segmentIndexAtChar(offsets: readonly number[], charOffset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid]! <= charOffset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function inText(t: Transcript, charOffset: number): boolean {
  return Number.isFinite(charOffset) && charOffset >= 0 && charOffset < t.text.length;
}

export function segmentAtChar(t: Transcript, charOffset: number): Segment | undefined {
  if (!inText(t, charOffset)) return undefined;
  const i = segmentIndexAtChar(textLayout(t).offsets, charOffset);
  return i >= 0 ? t.segments[i] : undefined;
}

/**
 * Media time for a char offset: the start of its segment, or of the nearest
 * earlier segment that has one (paragraphs inside a turn carry no time of
 * their own).
 */
export function startSecAtChar(t: Transcript, charOffset: number): number | undefined {
  if (!inText(t, charOffset)) return undefined;
  for (let i = segmentIndexAtChar(textLayout(t).offsets, charOffset); i >= 0; i--) {
    const start = t.segments[i]?.start;
    if (start !== undefined) return start;
  }
  return undefined;
}

// Cut in the back half of the window: at a line break (segment boundary) if
// there is one, else after a sentence, else at a space.
function chunkEnd(text: string, start: number, maxChars: number): number {
  const hardEnd = start + maxChars;
  if (hardEnd >= text.length) return text.length;
  const floor = start + Math.floor(maxChars / 2);
  const newline = text.lastIndexOf('\n', hardEnd);
  if (newline >= floor) return newline;
  const window = text.slice(floor, hardEnd);
  const sentence = [...window.matchAll(/[.!?]["')\]]?\s/g)].pop();
  if (sentence) return floor + sentence.index + sentence[0].length - 1;
  const space = text.lastIndexOf(' ', hardEnd);
  return space >= floor ? space : hardEnd;
}

// The next window starts about `overlap` chars before the previous end, moved
// forward to the first line start (else word start) so no line is cut.
function nextStart(text: string, start: number, end: number, overlap: number): number {
  let next = end;
  if (overlap > 0) {
    const target = end - overlap;
    const newline = text.indexOf('\n', target);
    const space = text.indexOf(' ', target);
    if (newline !== -1 && newline < end) next = newline + 1;
    else if (space !== -1 && space < end) next = space + 1;
    else next = target;
  }
  while (next < text.length && /\s/.test(text[next]!)) next++;
  return next > start ? next : end;
}

/** Overlapping windows over t.text; chunk.text === t.text.slice(startChar, endChar). */
export function chunkTranscript(t: Transcript, maxChars = 12000, overlapChars = 800): Chunk[] {
  if (!Number.isFinite(maxChars) || maxChars < 1) throw new RangeError(`maxChars must be >= 1 (got ${maxChars})`);
  const overlap = Math.max(0, Math.min(Math.floor(overlapChars), Math.floor(maxChars / 2)));
  const { text } = t;
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.max(chunkEnd(text, start, maxChars), start + 1);
    const chunk: Chunk = { index: chunks.length, text: text.slice(start, end), startChar: start, endChar: end };
    const startSec = startSecAtChar(t, start);
    if (startSec !== undefined) chunk.startSec = startSec;
    chunks.push(chunk);
    if (end >= text.length) break;
    start = nextStart(text, start, end, overlap);
  }
  return chunks;
}
