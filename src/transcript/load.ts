// Load a transcript from a local file, a web page, a YouTube URL or an audio
// file into Segments, then into a Transcript whose text maps back to them
// (buildText). The parsers are pure; the I/O edges (yt-dlp, fetch, OpenAI
// audio transcription) are thin and take injectable dependencies for tests.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { OPENAI_BASE_URL, redactSecrets } from '../llm/openai.ts';
import type { FetchLike } from '../llm/openai.ts';
import { LLMUnavailableError } from '../llm/provider.ts';
import type { Segment, SourceKind, Transcript } from '../types.ts';
import { withoutSignedParams } from '../url.ts';
import { buildText } from './chunk.ts';

export interface LoadOptions {
  title?: string;
  date?: string;
  url?: string;
  kind?: SourceKind;
  /** Test seams; the defaults use the global fetch, OPENAI_API_KEY and yt-dlp on PATH. */
  fetch?: FetchLike;
  openaiKey?: string;
  ytDlpBin?: string;
  /** Trim after loading (applyMaxMinutes); the cache keeps the full transcript. */
  maxMinutes?: number;
  /** Min gap between YouTube requests. appLoadTranscript passes 20_000; a bare loadTranscript call does not wait (0). */
  youtubeGapMs?: number;
  /** When set: read and write the transcript cache. */
  cacheDir?: string;
  /** Human progress lines ("YouTube is busy, trying another way to get captions..."). */
  onStatus?: (message: string) => void;
}

type TranscriptMeta = Transcript['meta'];

interface Loaded {
  segments: Segment[];
  meta: TranscriptMeta;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEB_TIMEOUT_MS = 60_000;
const AUDIO_TIMEOUT_MS = 600_000;

// ---- Shared text helpers -------------------------------------------------

function normalizeNewlines(s: string): string {
  return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

function collapseSpaces(s: string): string {
  return s.replace(/[ \t ]+/g, ' ').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä', ccedil: 'ç', ntilde: 'ñ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** "01:02:03.500", "1:02:03", "02:03,5" -> seconds; undefined when not a clock time. */
export function parseClock(s: string): number | undefined {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?$/.exec(s.trim());
  if (!m) return undefined;
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (seconds >= 60 || (m[1] !== undefined && minutes >= 60)) return undefined;
  const fraction = m[4] ? Number(`0.${m[4]}`) : 0;
  return Math.round((hours * 3600 + minutes * 60 + seconds + fraction) * 1000) / 1000;
}

function withSpeaker(seg: Segment, speaker: string | undefined): Segment {
  return speaker ? { ...seg, speaker } : seg;
}

// ---- VTT / SRT -------------------------------------------------------------

interface Cue {
  start: number;
  lines: string[];
}

const CUE_TIMING_RE = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

// Line based, because YouTube cues contain whitespace-only lines (" ") that
// are not cue separators; only a truly empty line (or the next timing line)
// ends a cue.
function parseCues(s: string): Cue[] {
  const lines = normalizeNewlines(s).split('\n');
  const cues: Cue[] = [];
  let cue: Cue | null = null;
  lines.forEach((line, i) => {
    const timing = CUE_TIMING_RE.exec(line);
    if (timing) {
      cue = { start: parseClock(timing[1]!) ?? 0, lines: [] };
      cues.push(cue);
    } else if (line === '' || (/^\s*\d+\s*$/.test(line) && CUE_TIMING_RE.test(lines[i + 1] ?? ''))) {
      cue = null; // end of cue, or an SRT index right before the next timing
    } else if (cue) {
      cue.lines.push(line);
    }
  });
  return cues;
}

const NON_SPEECH_RE = /\[\s*(?:music|applause|laughter|laughs|inaudible|crosstalk|silence|__)\s*\]|[♪♫]/gi;

/** Strip cue markup (inline <00:00:01.234> times, <c>, <v Name>, <i>, {\an8}) and entities. */
function cleanCueLine(line: string): { text: string; speaker?: string } {
  const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(line);
  const text = decodeEntities(line.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, ''))
    .replace(NON_SPEECH_RE, ' ')
    .replace(/(^|\s)>>(?=\s|$)/g, ' ');
  const speaker = voice?.[1]?.trim();
  return speaker ? { text: collapseSpaces(text), speaker } : { text: collapseSpaces(text) };
}

function sameLine(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// Auto-captions scroll: each cue repeats the line(s) already shown, and some
// styles grow a line word by word. Keep every line once, at the cue time it
// first appeared.
function dedupeRolling(lines: { start: number; text: string; speaker?: string }[]): Segment[] {
  const out: Segment[] = [];
  for (const line of lines) {
    if (!line.text) continue;
    const recent = out.slice(-2);
    if (recent.some((seg) => sameLine(seg.text, line.text))) continue;
    const last = out[out.length - 1];
    if (last && line.text.toLowerCase().startsWith(`${last.text.toLowerCase()} `)) {
      last.text = line.text;
      continue;
    }
    out.push(withSpeaker({ start: line.start, text: line.text }, line.speaker));
  }
  return out;
}

// A <v Name> span runs to its </v> or to the end of the cue (WebVTT), so
// every later line of the cue is that voice's too.
function voicedCueLines(cue: Cue): { start: number; text: string; speaker?: string }[] {
  let voice: string | undefined;
  return cue.lines.map((raw) => {
    const cleaned = cleanCueLine(raw);
    voice = cleaned.speaker ?? voice;
    const line = voice ? { start: cue.start, text: cleaned.text, speaker: voice } : { start: cue.start, text: cleaned.text };
    if (/<\/v\s*>/i.test(raw)) voice = undefined;
    return line;
  });
}

export function parseVtt(s: string): Segment[] {
  return dedupeRolling(parseCues(s).flatMap(voicedCueLines));
}

export function parseSrt(s: string): Segment[] {
  const cues = parseCues(s).map((cue) => {
    const cleaned = cue.lines.map(cleanCueLine);
    const speaker = cleaned.find((c) => c.speaker)?.speaker;
    return { start: cue.start, text: collapseSpaces(cleaned.map((c) => c.text).join(' ')), speaker };
  });
  const labels = recurringLabels(cues.map((c) => c.text));
  const lines = cues.map((cue) => {
    const g = NAME_LABEL_RE.exec(cue.text)?.groups;
    return !cue.speaker && g?.name && labels.has(g.name) ? { ...cue, text: collapseSpaces(g.text ?? ''), speaker: g.name } : cue;
  });
  return dedupeRolling(lines);
}

// ---- Plain text ------------------------------------------------------------

const TS = String.raw`(?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d+)?`;
const NAME = String.raw`[\p{Lu}][\p{L}\p{M}.'’-]*(?:[ \t]+[\p{Lu}\p{N}][\p{L}\p{M}\p{N}.'’-]*){0,3}`;
const DASH = String.raw`(?:[-–—]\s*)?`;

// Each pattern: groups `ts`, `name`, `text` (all optional except as written).
const HEADER_PATTERNS: RegExp[] = [
  // [00:01:02] Name: text   (00:01:02) text
  new RegExp(String.raw`^[\[(](?<ts>${TS})[\])]\s*${DASH}(?:(?<name>${NAME})\s*:(?:\s+|$))?(?<text>.*)$`, 'u'),
  // Name (00:01:02) text   Name [00:01:02]: text   (Lex Fridman style)
  new RegExp(String.raw`^(?<name>${NAME})\s*[\[(](?<ts>${TS})[\])]\s*:?\s*(?<text>.*)$`, 'u'),
  // 00:01:02 Name: text   01:02 Name: text
  new RegExp(String.raw`^(?<ts>${TS})\s+${DASH}(?<name>${NAME})\s*:(?:\s+|$)(?<text>.*)$`, 'u'),
  // 00:01:02 text   (hours required, so "10:30 is when we met" stays prose)
  new RegExp(String.raw`^(?<ts>\d+:\d{2}:\d{2}(?:[.,]\d+)?)\s+${DASH}(?<text>.+)$`, 'u'),
  // Name  00:03   (Otter style: header line, words on the following lines)
  new RegExp(String.raw`^(?<name>${NAME})\s+(?<ts>${TS})$`, 'u'),
];

const NAME_LABEL_RE = new RegExp(String.raw`^(?<name>${NAME})\s*:(?:\s+(?<text>.*)|$)`, 'u');
const NOT_SPEAKERS = new Set(['note', 'notes', 'update', 'source', 'sources', 'edit', 'title', 'date', 'summary', 'transcript', 'warning', 'disclaimer']);

interface Header {
  start?: number;
  speaker?: string;
  text: string;
}

// A bare "Name: text" only counts as a speaker label when the same name
// labels at least two lines, or the line sits next to such a line (a guest
// who speaks once in a labeled dialogue). "Important: ..." in prose stays text.
function recurringLabels(lines: readonly string[]): Set<string> {
  const names = lines.map((line) => {
    const name = NAME_LABEL_RE.exec(line)?.groups?.name;
    return name && !NOT_SPEAKERS.has(name.toLowerCase()) ? name : undefined;
  });
  const counts = new Map<string, number>();
  for (const name of names) if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  const recurring = (name: string | undefined) => name !== undefined && (counts.get(name) ?? 0) >= 2;
  const neighbour = (i: number, step: 1 | -1) => {
    let j = i + step;
    while (lines[j] === '') j += step;
    return names[j];
  };
  const labels = new Set<string>();
  names.forEach((name, i) => {
    if (name && (recurring(name) || recurring(neighbour(i, -1)) || recurring(neighbour(i, 1)))) labels.add(name);
  });
  return labels;
}

function parseHeader(line: string, labels: ReadonlySet<string>): Header | null {
  for (const re of HEADER_PATTERNS) {
    const g = re.exec(line)?.groups;
    if (!g) continue;
    const start = g.ts === undefined ? undefined : parseClock(g.ts);
    if (g.ts !== undefined && start === undefined) continue;
    const header: Header = { text: collapseSpaces(g.text ?? '') };
    if (start !== undefined) header.start = start;
    if (g.name) header.speaker = collapseSpaces(g.name);
    return header;
  }
  const g = NAME_LABEL_RE.exec(line)?.groups;
  if (g?.name && labels.has(g.name)) return { speaker: g.name, text: collapseSpaces(g.text ?? '') };
  return null;
}

/**
 * Plain transcripts: "[hh:mm:ss] text", "(hh:mm:ss) text", "Name (hh:mm:ss)
 * text", "Name: text", "hh:mm:ss Name: text", or prose. A header line starts
 * a segment; following lines continue it; after a blank line a new paragraph
 * becomes its own segment for the same speaker.
 */
export function parsePlain(s: string): Segment[] {
  const lines = normalizeNewlines(s)
    .split('\n')
    .map((l) => collapseSpaces(l));
  const labels = recurringLabels(lines);
  const out: Segment[] = [];
  let speaker: string | undefined;
  let current: Segment | null = null;
  let paragraphBreak = false;
  for (const line of lines) {
    if (!line) {
      paragraphBreak = true;
      continue;
    }
    const header = parseHeader(line, labels);
    if (header) {
      speaker = header.speaker;
      current = withSpeaker(header.start === undefined ? { text: header.text } : { start: header.start, text: header.text }, speaker);
      out.push(current);
    } else if (current && (!paragraphBreak || current.text === '')) {
      current.text = current.text ? `${current.text} ${line}` : line;
    } else {
      current = withSpeaker({ text: line }, speaker);
      out.push(current);
    }
    paragraphBreak = false;
  }
  return out.filter((seg) => seg.text !== '');
}

// ---- HTML ------------------------------------------------------------------

const DROPPED_ELEMENTS = ['script', 'style', 'noscript', 'template', 'svg', 'head', 'title', 'nav', 'header', 'footer', 'aside', 'form', 'iframe'];
const DROP_RE = new RegExp(String.raw`<(${DROPPED_ELEMENTS.join('|')})\b[^>]*>[\s\S]*?<\/\1\s*>`, 'gi');
const BLOCK_END_RE = /<\/(?:p|div|section|article|main|blockquote|li|ul|ol|h[1-6]|tr|table|pre|figure|figcaption|dd|dt)\s*>/gi;
const BLOCK_START_RE = /<(?:p|div|section|article|main|blockquote|li|h[1-6]|tr|pre|figure|dd|dt)\b[^>]*>/gi;

/** Readable text of a page: boilerplate elements dropped, paragraph breaks kept, entities decoded. */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(DROP_RE, ' ');
  }
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_END_RE, '\n\n')
    .replace(BLOCK_START_RE, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .split('\n')
    .map((line) => collapseSpaces(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** og:title, else <title>. */
export function htmlTitle(html: string): string | undefined {
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1];
  const title = og ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const clean = title ? collapseSpaces(decodeEntities(title)) : '';
  return clean || undefined;
}

// ---- JSON ------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function segmentFromItem(item: unknown): Segment | null {
  if (!isRecord(item) || typeof item.text !== 'string') return null;
  const text = collapseSpaces(item.text.replace(/\n/g, ' '));
  if (!text) return null;
  const raw = item.start;
  const start = typeof raw === 'number' ? raw : typeof raw === 'string' ? (parseClock(raw) ?? Number(raw)) : undefined;
  const seg: Segment = start !== undefined && Number.isFinite(start) ? { start, text } : { text };
  return withSpeaker(seg, typeof item.speaker === 'string' ? item.speaker.trim() : undefined);
}

// yt-dlp json3: { events: [{ tStartMs, segs: [{ utf8 }] }] }; words of one
// event concatenate, newline-only events are layout.
function segmentsFromJson3(events: unknown[]): Segment[] {
  const lines = events.flatMap((ev) => {
    if (!isRecord(ev) || !Array.isArray(ev.segs) || typeof ev.tStartMs !== 'number') return [];
    const text = collapseSpaces(
      ev.segs
        .map((seg) => (isRecord(seg) && typeof seg.utf8 === 'string' ? seg.utf8 : ''))
        .join('')
        .replace(/\n/g, ' '),
    );
    return [{ start: ev.tStartMs / 1000, ...cleanCueLine(text) }];
  });
  return dedupeRolling(lines);
}

/** `{segments:[{start,text,speaker?}]}` (also Whisper verbose_json), a bare segment array, or yt-dlp json3. */
export function parseJsonTranscript(s: string): Segment[] {
  const data: unknown = JSON.parse(s);
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.segments) ? data.segments : null;
  if (list) return list.map(segmentFromItem).filter((seg): seg is Segment => seg !== null);
  if (isRecord(data) && Array.isArray(data.events)) return segmentsFromJson3(data.events);
  throw new Error('Unrecognized JSON transcript: expected {"segments": [...]} or yt-dlp json3 {"events": [...]}');
}

// ---- Audio (OpenAI transcription) ----------------------------------------

export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.webm', '.mp4', '.mpeg', '.mpga', '.ogg', '.flac'];
/** Local transcript files loadFile parses (anything else is read as plain text). */
export const TRANSCRIPT_EXTENSIONS = ['.txt', '.md', '.vtt', '.srt', '.json', '.html', '.htm'];
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface TranscribeOptions {
  apiKey?: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

/** Whisper (`whisper-1`, verbose_json) segments for a local audio file of at most 25 MB. */
export async function transcribeAudio(path: string, opts: TranscribeOptions = {}): Promise<Segment[]> {
  const size = statSync(path).size;
  if (size > MAX_AUDIO_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    throw new Error(
      `${basename(path)} is ${mb} MB; OpenAI transcription accepts at most 25 MB. ` +
        'Compress or split it first, e.g. ffmpeg -i in.mp3 -ac 1 -b:a 32k out.mp3',
    );
  }
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new LLMUnavailableError('OPENAI_API_KEY missing: it is needed to transcribe audio files');
  const form = new FormData();
  const audio = Bun.file(path);
  // A File, not the BunFile itself, so the upload is named "clip.mp3" rather than its full local path.
  form.append('file', new File([await audio.arrayBuffer()], basename(path), { type: audio.type }));
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const res = await doFetch(`${opts.baseUrl ?? OPENAI_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(AUDIO_TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error('OPENAI_API_KEY rejected by the transcription API (HTTP 401)');
  if (!res.ok) {
    const detail = redactSecrets((await res.text().catch(() => '')).slice(0, 300));
    throw new Error(`Audio transcription failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const body: unknown = await res.json();
  const segments = isRecord(body) && Array.isArray(body.segments) ? parseJsonTranscript(JSON.stringify(body)) : [];
  if (segments.length > 0) return segments;
  const text = isRecord(body) && typeof body.text === 'string' ? body.text.trim() : '';
  return text ? [{ start: 0, text }] : [];
}

// ---- YouTube (yt-dlp) ------------------------------------------------------

export function isYouTubeUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname.replace(/^(?:www|m|music)\./, '');
    return host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com';
  } catch {
    return false;
  }
}

/** argv for fetching subtitles + metadata only; outDir receives <id>.<lang>.vtt. */
export function ytDlpArgs(url: string, outDir: string, bin = 'yt-dlp'): string[] {
  return [
    bin,
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
    join(outDir, '%(id)s'),
    url,
  ];
}

export interface YtDlpMeta {
  id?: string;
  title?: string;
  url?: string;
  date?: string;
  channel?: string;
  durationSec?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function ytDate(json: Record<string, unknown>): string | undefined {
  for (const key of ['upload_date', 'release_date']) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(str(json[key]) ?? '');
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  const ts = json.timestamp ?? json.release_timestamp;
  return typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts * 1000).toISOString().slice(0, 10) : undefined;
}

/** The fields Receipts keeps from a yt-dlp --print-json record. */
export function mapYtDlpMeta(json: unknown): YtDlpMeta {
  if (!isRecord(json)) return {};
  const meta: YtDlpMeta = {
    id: str(json.id),
    title: str(json.title),
    url: str(json.webpage_url) ?? str(json.original_url),
    date: ytDate(json),
    channel: str(json.channel) ?? str(json.uploader),
    durationSec: typeof json.duration === 'number' && Number.isFinite(json.duration) ? json.duration : undefined,
  };
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) as YtDlpMeta;
}

function subtitleRank(lang: string): number {
  if (lang === 'en') return 0;
  if (/^en-(?:US|GB)$/i.test(lang)) return 1;
  if (lang === 'en-orig') return 3;
  return lang.startsWith('en') ? 2 : 4;
}

/** Best English .vtt among yt-dlp's outputs: en, en-US/GB, other en-*, en-orig, anything else. */
export function pickSubtitleFile(files: readonly string[], id?: string): string | undefined {
  const langOf = (f: string) => /\.([^.]+)\.vtt$/.exec(f)?.[1] ?? '';
  return files
    .filter((f) => f.endsWith('.vtt') && (!id || f.startsWith(`${id}.`)))
    .sort((a, b) => subtitleRank(langOf(a)) - subtitleRank(langOf(b)) || a.localeCompare(b))[0];
}

function lastJsonLine(stdout: string): unknown {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  if (!line) return {};
  try {
    return JSON.parse(line);
  } catch {
    return {};
  }
}

async function loadYouTube(url: string, bin: string): Promise<Loaded> {
  if (!Bun.which(bin)) {
    throw new Error('yt-dlp is not installed; it is needed for YouTube URLs. Install it with "brew install yt-dlp" (or "pipx install yt-dlp").');
  }
  const dir = mkdtempSync(join(tmpdir(), 'receipts-yt-'));
  try {
    const proc = Bun.spawn(ytDlpArgs(url, dir, bin), { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`yt-dlp failed (exit ${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
    const yt = mapYtDlpMeta(lastJsonLine(stdout));
    const file = pickSubtitleFile(readdirSync(dir), yt.id);
    if (!file) {
      throw new Error(
        `No English subtitles found for ${url}. Download the audio (yt-dlp -x --audio-format mp3 <url>) and pass the audio file instead.`,
      );
    }
    const segments = parseVtt(await Bun.file(join(dir, file)).text());
    const { id: _id, ...meta } = yt;
    return { segments, meta: { ...meta, url: meta.url ?? url, kind: 'podcast' } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Web pages -------------------------------------------------------------

async function loadWebPage(url: string, doFetch: FetchLike): Promise<Loaded> {
  const res = await doFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Receipts transcript loader)', Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
    signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Fetching ${url} failed: HTTP ${res.status}`);
  const body = await res.text();
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const path = new URL(url).pathname.toLowerCase();
  const meta: TranscriptMeta = { url, kind: 'article' };
  if (path.endsWith('.vtt') || type.includes('text/vtt')) return { segments: parseVtt(body), meta: { ...meta, kind: 'podcast' } };
  if (path.endsWith('.srt')) return { segments: parseSrt(body), meta: { ...meta, kind: 'podcast' } };
  if (path.endsWith('.json') || type.includes('json')) return { segments: parseJsonTranscript(body), meta: { ...meta, kind: 'podcast' } };
  if (type.includes('html') || /^\s*<(?:!doctype|html)/i.test(body)) {
    const title = htmlTitle(body);
    return { segments: parsePlain(htmlToText(body)), meta: title ? { ...meta, title } : meta };
  }
  return { segments: parsePlain(body), meta };
}

// ---- Local files -----------------------------------------------------------

/** `given` is the path as the user typed it: errors show that, never the resolved absolute path. */
async function loadFile(path: string, opts: LoadOptions, given: string = path): Promise<Loaded> {
  if (!existsSync(path)) {
    const relative = !given.startsWith('/') && !given.startsWith('~');
    throw new Error(`No such file: ${given}${relative ? ' (a relative path is read from the folder receipts was started in)' : ''}`);
  }
  const ext = extname(path).toLowerCase();
  const meta: TranscriptMeta = { title: basename(path, extname(path)), kind: 'podcast' };
  if (AUDIO_EXTENSIONS.includes(ext)) {
    return { segments: await transcribeAudio(path, { apiKey: opts.openaiKey, fetch: opts.fetch }), meta };
  }
  const text = await Bun.file(path).text();
  switch (ext) {
    case '.vtt':
      return { segments: parseVtt(text), meta };
    case '.srt':
      return { segments: parseSrt(text), meta };
    case '.json':
      return { segments: parseJsonTranscript(text), meta };
    case '.html':
    case '.htm':
      return { segments: parsePlain(htmlToText(text)), meta: { ...meta, title: htmlTitle(text) ?? meta.title, kind: 'article' } };
    default:
      return { segments: parsePlain(text), meta };
  }
}

export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

// ---- YouTube fallback, request gate, cache, trim ------------------------

/** The 11-char video id of any YouTube URL form (watch?v=, youtu.be, /live/, /embed/, /shorts/, /v/), else null. */
export function youtubeVideoId(input: string): string | null {
  if (!isYouTubeUrl(input)) return null;
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const idRe = /^[A-Za-z0-9_-]{11}$/;
  const host = u.hostname.replace(/^(?:www|m|music)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  const candidate =
    host === 'youtu.be'
      ? parts[0]
      : (u.searchParams.get('v') ?? (['live', 'embed', 'shorts', 'v', 'e'].includes(parts[0] ?? '') ? parts[1] : undefined));
  return candidate && idRe.test(candidate) ? candidate : null;
}

let lastYouTubeRequest = 0;

/** Await the next YouTube request slot (module-level last-request time; one request per gapMs across yt-dlp and the fallback). */
export async function youtubeGate(gapMs: number, sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms)): Promise<void> {
  const wait = lastYouTubeRequest + gapMs - Date.now();
  if (gapMs > 0 && wait > 0) await sleep(wait);
  lastYouTubeRequest = Date.now();
}

/** Pure: find and parse the player response JSON in watch-page HTML (balanced-brace scan after 'ytInitialPlayerResponse = '). Null when absent. */
export function playerResponseFromHtml(html: string): unknown | null {
  const marker = /ytInitialPlayerResponse\s*=\s*\{/.exec(html);
  if (!marker) return null;
  const start = marker.index + marker[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: string;
}

function textOf(v: unknown): string | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.simpleText === 'string') return v.simpleText;
  if (Array.isArray(v.runs)) return v.runs.map((r) => (isRecord(r) && typeof r.text === 'string' ? r.text : '')).join('') || undefined;
  return undefined;
}

export function captionTracksOf(player: unknown): CaptionTrack[] {
  if (!isRecord(player) || !isRecord(player.captions)) return [];
  const renderer = player.captions.playerCaptionsTracklistRenderer;
  if (!isRecord(renderer) || !Array.isArray(renderer.captionTracks)) return [];
  return renderer.captionTracks.flatMap((t): CaptionTrack[] => {
    if (!isRecord(t) || typeof t.baseUrl !== 'string' || typeof t.languageCode !== 'string') return [];
    const track: CaptionTrack = { baseUrl: t.baseUrl, languageCode: t.languageCode };
    if (typeof t.kind === 'string') track.kind = t.kind;
    const name = textOf(t.name);
    if (name) track.name = name;
    return [track];
  });
}

/** Best English track: same language rank as pickSubtitleFile, a manual track before an automatic ('asr') one. Null when no English track exists. */
export function pickCaptionTrack(tracks: readonly CaptionTrack[]): CaptionTrack | null {
  const english = tracks.filter((t) => t.languageCode.toLowerCase().startsWith('en'));
  const ranked = [...english].sort(
    (a, b) => subtitleRank(a.languageCode) - subtitleRank(b.languageCode) || Number(a.kind === 'asr') - Number(b.kind === 'asr'),
  );
  // Manual before asr wins over the language order: a manual en-GB track beats an automatic en one.
  return ranked.find((t) => t.kind !== 'asr') ?? ranked[0] ?? null;
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'CONSENT=YES+1',
};

const INNERTUBE_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en' };
const INNERTUBE_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip';

/** Player data from YouTube's own app API (the Android client): its caption links work without the browser's proof-of-origin token. */
async function innertubePlayer(id: string, doFetch: FetchLike): Promise<unknown> {
  const res = await doFetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': INNERTUBE_UA },
    body: JSON.stringify({ context: { client: INNERTUBE_CLIENT }, videoId: id }),
    signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`YouTube player API failed: HTTP ${res.status}`);
  return res.json();
}

async function watchPagePlayer(id: string, doFetch: FetchLike): Promise<unknown> {
  const page = await doFetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(WEB_TIMEOUT_MS) });
  if (!page.ok) throw new Error(`YouTube watch page failed: HTTP ${page.status}`);
  const player = playerResponseFromHtml(await page.text());
  if (!player) throw new Error('YouTube watch page had no player data.');
  return player;
}

async function captionsOfPlayer(player: unknown, doFetch: FetchLike, headers: Record<string, string>): Promise<Segment[]> {
  const track = pickCaptionTrack(captionTracksOf(player));
  if (!track) throw new Error('This video has no English captions.');
  const base = track.baseUrl.startsWith('http') ? track.baseUrl : `https://www.youtube.com${track.baseUrl}`;
  const res = await doFetch(`${base.replace(/&fmt=[^&]*/, '')}&fmt=json3`, { headers, signal: AbortSignal.timeout(WEB_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`YouTube captions failed: HTTP ${res.status}`);
  const body = (await res.text()).trim();
  if (!body) throw new Error('YouTube returned empty captions (it may require a sign-in token).');
  const segments = parseJsonTranscript(body);
  if (segments.length === 0) throw new Error('YouTube captions were empty.');
  return segments;
}

function metaOfPlayer(player: unknown, id: string): Transcript['meta'] {
  const meta: Transcript['meta'] = { url: `https://www.youtube.com/watch?v=${id}`, kind: 'podcast' };
  if (!isRecord(player)) return meta;
  if (isRecord(player.videoDetails)) {
    const d = player.videoDetails;
    if (typeof d.title === 'string' && d.title.trim()) meta.title = d.title.trim();
    if (typeof d.author === 'string' && d.author.trim()) meta.channel = d.author.trim();
    const len = Number(d.lengthSeconds);
    if (Number.isFinite(len) && len > 0) meta.durationSec = len;
  }
  const micro = isRecord(player.microformat) && isRecord(player.microformat.playerMicroformatRenderer) ? player.microformat.playerMicroformatRenderer : null;
  const published = micro && typeof micro.publishDate === 'string' ? micro.publishDate.slice(0, 10) : undefined;
  if (published && DATE_RE.test(published)) meta.date = published;
  return meta;
}

/**
 * YouTube captions without yt-dlp. First the app player API (one POST, then
 * the json3 captions), then the watch page's ytInitialPlayerResponse with the
 * best English captionTracks entry. Throws when both fail.
 */
export async function loadYouTubeCaptions(url: string, doFetch: FetchLike): Promise<{ segments: Segment[]; meta: Transcript['meta'] }> {
  const id = youtubeVideoId(url);
  if (!id) throw new Error(`Not a YouTube video link: ${url}`);
  const problems: string[] = [];
  try {
    const player = await innertubePlayer(id, doFetch);
    return { segments: await captionsOfPlayer(player, doFetch, { 'User-Agent': INNERTUBE_UA }), meta: metaOfPlayer(player, id) };
  } catch (err) {
    problems.push((err as Error).message);
  }
  try {
    const player = await watchPagePlayer(id, doFetch);
    return { segments: await captionsOfPlayer(player, doFetch, BROWSER_HEADERS), meta: metaOfPlayer(player, id) };
  } catch (err) {
    problems.push((err as Error).message);
  }
  throw new Error(`YouTube captions fallback failed: ${problems.join('; ')}`);
}

/** yt-dlp failures the captions fallback can route around: missing binary, rate limit, bot check. */
export function isYtDlpBlocked(message: string): boolean {
  return /\b429\b|too many requests|sign in to confirm|yt-dlp is not installed/i.test(message);
}

// ---- Transcript cache ------------------------------------------------------------

/** Cache identity: 'youtube:<id>' for any YouTube form, else the URL without hash and signed params, else the absolute file path. */
export function transcriptCacheKey(input: string): string {
  const id = youtubeVideoId(input);
  if (id) return `youtube:${id}`;
  if (isHttpUrl(input)) {
    try {
      const u = new URL(withoutSignedParams(input.trim()));
      u.hash = '';
      return u.toString();
    } catch {
      return input.trim();
    }
  }
  return `file:${resolve(input.startsWith('~/') ? join(homedir(), input.slice(2)) : input)}`;
}

/** <cacheDir>/<first 16 hex of sha256(cache key)>.json */
export function transcriptCachePath(cacheDir: string, url: string): string {
  return join(cacheDir, `${createHash('sha256').update(transcriptCacheKey(url)).digest('hex').slice(0, 16)}.json`);
}

export function readCachedTranscript(cacheDir: string, url: string): Transcript | null {
  const path = transcriptCachePath(cacheDir, url);
  if (!existsSync(path)) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(data) || !Array.isArray(data.segments) || !isRecord(data.meta)) return null;
    const segments = data.segments as Segment[];
    if (segments.length === 0) return null;
    return { text: buildText(segments).text, segments, meta: data.meta as Transcript['meta'] };
  } catch {
    return null;
  }
}

/** Writes the untrimmed transcript (atomic). */
export function writeCachedTranscript(cacheDir: string, url: string, t: Transcript): void {
  const path = transcriptCachePath(cacheDir, url);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ key: transcriptCacheKey(url), meta: t.meta, segments: t.segments })}\n`);
  renameSync(tmp, path);
}

// ---- Trim ---------------------------------------------------------------------------

const CHARS_PER_MINUTE = 900;

/** Segments with start < maxMinutes*60; when no segment has a start, the first maxMinutes*900 characters (about 150 words a minute). Returns the transcript unchanged when nothing is cut. Rebuilds text with buildText. */
export function applyMaxMinutes(t: Transcript, maxMinutes: number): { transcript: Transcript; trimmed: boolean } {
  if (!(maxMinutes > 0)) return { transcript: t, trimmed: false };
  const timed = t.segments.some((s) => s.start !== undefined);
  let kept: Segment[];
  if (timed) {
    const limit = maxMinutes * 60;
    const cut = t.segments.findIndex((s) => s.start !== undefined && s.start >= limit);
    kept = cut < 0 ? t.segments : t.segments.slice(0, cut);
  } else {
    const budget = maxMinutes * CHARS_PER_MINUTE;
    kept = [];
    let used = 0;
    for (const seg of t.segments) {
      if (used >= budget) break;
      const room = budget - used;
      if (seg.text.length <= room) {
        kept.push(seg);
        used += seg.text.length + 1;
      } else {
        const slice = seg.text.slice(0, room);
        const atWord = slice.lastIndexOf(' ');
        const text = (atWord > room * 0.5 ? slice.slice(0, atWord) : slice).trim();
        if (text) kept.push({ ...seg, text });
        used = budget;
      }
    }
  }
  if (kept.length === t.segments.length && kept.every((s, i) => s === t.segments[i])) return { transcript: t, trimmed: false };
  if (kept.length === 0) kept = t.segments.slice(0, 1);
  return { transcript: { text: buildText(kept).text, segments: kept, meta: t.meta }, trimmed: true };
}

// ---- Entry point ---------------------------------------------------------------------

async function loadYouTubeWithFallback(url: string, opts: LoadOptions): Promise<Loaded> {
  const gap = opts.youtubeGapMs ?? 0;
  await youtubeGate(gap);
  try {
    return await loadYouTube(url, opts.ytDlpBin ?? 'yt-dlp');
  } catch (err) {
    const message = (err as Error).message;
    if (!isYtDlpBlocked(message)) throw err;
    opts.onStatus?.('YouTube is busy, trying another way to get captions...');
    await youtubeGate(gap);
    try {
      return await loadYouTubeCaptions(url, opts.fetch ?? ((u, init) => fetch(u, init)));
    } catch {
      throw err;
    }
  }
}

/**
 * Local .txt/.md/.vtt/.srt/.json/.html, audio (OpenAI transcription), a
 * YouTube URL (yt-dlp subtitles, then the built-in captions fallback when
 * yt-dlp is missing or rate-limited) or any other http(s) page. Explicit
 * options win over what the source says about itself. With `cacheDir`, the
 * full transcript is cached; `maxMinutes` trims after the cache.
 */
export async function loadTranscript(input: string, opts: LoadOptions = {}): Promise<Transcript> {
  const source = input.trim();
  if (opts.date !== undefined && !DATE_RE.test(opts.date)) throw new Error(`date must be YYYY-MM-DD (got "${opts.date}")`);
  const cached = opts.cacheDir ? readCachedTranscript(opts.cacheDir, source) : null;
  let loaded: Loaded;
  if (cached) {
    opts.onStatus?.('Using the saved transcript.');
    loaded = { segments: cached.segments, meta: cached.meta };
  } else {
    loaded = isYouTubeUrl(source)
      ? await loadYouTubeWithFallback(source, opts)
      : isHttpUrl(source)
        ? await loadWebPage(source, opts.fetch ?? ((url, init) => fetch(url, init)))
        : await loadFile(source.startsWith('~/') ? join(homedir(), source.slice(2)) : resolve(source), opts, source);
    if (loaded.segments.length === 0) throw new Error(`No transcript text found in ${source}`);
    if (opts.cacheDir) {
      try {
        writeCachedTranscript(opts.cacheDir, source, { text: '', segments: loaded.segments, meta: loaded.meta });
      } catch {
        // A cache that cannot be written only costs a re-download next time.
      }
    }
  }
  const given: TranscriptMeta = { title: opts.title, url: opts.url, date: opts.date, kind: opts.kind };
  const meta = { ...loaded.meta, ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) };
  const full: Transcript = { text: buildText(loaded.segments).text, segments: loaded.segments, meta };
  return opts.maxMinutes ? applyMaxMinutes(full, opts.maxMinutes).transcript : full;
}
