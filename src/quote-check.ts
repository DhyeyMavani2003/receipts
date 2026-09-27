// Verify that a quote the model extracted was actually said, and where.
// Defamation safety rests on this file: a claim is only kept when its quote
// matches the transcript. Matching tolerates what transcription and copying
// change (case, punctuation, curly quotes, filler words, a small ASR slip)
// but never a changed number or a flipped negation, which change the claim.

import { startSecAtChar, textLayout } from './transcript/chunk.ts';
import type { Transcript } from './types.ts';

export interface QuoteMatch {
  verified: boolean;
  /** Verbatim transcript words for the match (whitespace collapsed); only set when verified. */
  matchedText?: string;
  charOffset?: number;
  /** Offset just past the last matched character (charOffset + span length in t.text). */
  endOffset?: number;
  /** 1 = exact after normalization; 1 - (token edits / quote tokens) otherwise. */
  score: number;
  timestampSec?: number;
  deepLink?: string;
  /** Speaker label of the matched line, when the transcript has one. */
  speaker?: string;
  /** Why the quote was rejected. */
  reason?: string;
}

export interface QuoteCheckOptions {
  /** Only accept matches in lines labeled with this speaker (unlabeled lines and anonymous labels pass). */
  speaker?: string;
  /** The interviewer's name: lines labeled with it are never the speaker's. */
  host?: string;
  minScore?: number;
}

export const MIN_QUOTE_SCORE = 0.85;

// ---- Normalization -------------------------------------------------------

interface Token {
  norm: string;
  start: number;
  end: number;
  region: number;
}

// A word, keeping apostrophes inside words ("won't") and separators inside
// numbers ("1,000", "1.5") so they normalize as one token.
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:['‘’ʼ][\p{L}\p{M}\p{N}]+|(?<=\p{N})[.,]\p{N}+)*%?/gu;

const FILLERS = new Set(['uh', 'uhh', 'uhm', 'um', 'umm', 'erm', 'er', 'ah', 'hmm', 'mm', 'mhm']);

function normalizeWord(raw: string): string[] {
  const word = raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['‘’ʼ]/g, '')
    .replace(/(?<=\d),(?=\d)/g, '');
  return word.endsWith('%') ? [word.slice(0, -1), 'percent'] : [word];
}

function tokenizeRegion(text: string, from: number, to: number, region: number): Token[] {
  const tokens: Token[] = [];
  for (const m of text.slice(from, to).matchAll(WORD_RE)) {
    const start = from + m.index;
    const end = start + m[0].length;
    for (const norm of normalizeWord(m[0])) tokens.push({ norm, start, end, region });
  }
  return tokens;
}

function dropFillers(tokens: Token[]): Token[] {
  const kept: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const norm = tokens[i]!.norm;
    if (FILLERS.has(norm)) continue;
    if (norm === 'you' && tokens[i + 1]?.norm === 'know') {
      i++;
      continue;
    }
    kept.push(tokens[i]!);
  }
  return kept;
}

function tokensOf(s: string): Token[] {
  return dropFillers(tokenizeRegion(s, 0, s.length, 0));
}

/** Lowercase, straight quotes, no punctuation, single spaces, no "uh"/"um"/"you know". */
export function normalizeForMatch(s: string): string {
  return tokensOf(s)
    .map((t) => t.norm)
    .join(' ');
}

// Tokens of the transcript's spoken words, one region per segment, so that
// the speaker labels buildText() adds are never matched as quote words.
function tokenizeTranscript(t: Transcript): Token[] {
  const layout = textLayout(t);
  if (layout.offsets.length === 0) return dropFillers(tokenizeRegion(t.text, 0, t.text.length, -1));
  const tokens = layout.offsets.flatMap((_, i) => {
    const end = layout.offsets[i + 1] ?? t.text.length;
    return tokenizeRegion(t.text, layout.textStarts[i]!, end, i);
  });
  return dropFillers(tokens);
}

// extract.ts checks every candidate quote of an episode against the same transcript.
const tokenCache = new WeakMap<Transcript, { text: string; tokens: Token[] }>();

function transcriptTokens(t: Transcript): Token[] {
  const cached = tokenCache.get(t);
  if (cached && cached.text === t.text) return cached.tokens;
  const tokens = tokenizeTranscript(t);
  tokenCache.set(t, { text: t.text, tokens });
  return tokens;
}

// ---- Numbers and negations ----------------------------------------------

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const MULTIPLIERS: Record<string, number> = { hundred: 100, dozen: 12 };
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
// "thousands of robots" vs "millions of robots" is still a different claim.
const PLURAL_SCALES: Record<string, number> = {
  dozens: 12, hundreds: 100, thousands: 1e3, millions: 1e6, billions: 1e9, trillions: 1e12,
};
const ORDINALS = new Set([
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
]);

const NEGATIONS = new Set([
  'not', 'no', 'never', 'none', 'nobody', 'nothing', 'nowhere', 'neither', 'nor', 'cannot', 'cant', 'dont',
  'doesnt', 'didnt', 'wont', 'wouldnt', 'isnt', 'arent', 'wasnt', 'werent', 'havent', 'hasnt', 'hadnt',
  'shouldnt', 'couldnt', 'mustnt', 'neednt', 'shant', 'aint',
]);

type NumberWord = 'digits' | 'unit' | 'tens' | 'multiplier' | 'scale' | 'and';

function isScaleWord(w: string | undefined): boolean {
  return w !== undefined && (w in SCALES || w in MULTIPLIERS);
}

function numberWordKind(w: string, next: string | undefined, inRun: boolean): NumberWord | null {
  if (/^\d+(?:\.\d+)?$/.test(w)) return 'digits';
  if (w in UNITS || ((w === 'a' || w === 'an') && isScaleWord(next))) return 'unit';
  if (w in TENS) return 'tens';
  if (w in MULTIPLIERS) return 'multiplier';
  if (w in SCALES) return 'scale';
  if (w === 'and' && inRun && next !== undefined && (next in UNITS || next in TENS)) return 'and';
  return null;
}

// Which word kinds may follow which inside one number ("two hundred and
// fifty thousand"); anything else starts a new number ("2027 2028").
const FOLLOWS: Record<NumberWord, readonly NumberWord[]> = {
  digits: ['multiplier', 'scale'],
  unit: ['multiplier', 'scale'],
  tens: ['unit', 'multiplier', 'scale'],
  multiplier: ['unit', 'tens', 'scale', 'and'],
  scale: ['unit', 'tens', 'digits', 'and'],
  and: ['unit', 'tens'],
};

/**
 * Canonical number facts in a token list: values of digit and number-word
 * phrases ("ten thousand" and "10,000" both give "10000"), plus tokens that
 * mix letters and digits ("f2", "q3", "90s") and ordinals, sorted.
 */
export function numberSignature(words: readonly string[]): string[] {
  const out: string[] = [];
  let total = 0;
  let current = 0;
  let last: NumberWord | null = null;
  const flush = () => {
    // toPrecision: "1.1 million" and "1,100,000" must give the same string.
    if (last !== null) out.push(String(Number((total + current).toPrecision(12))));
    total = 0;
    current = 0;
    last = null;
  };
  words.forEach((w, i) => {
    const kind = numberWordKind(w, words[i + 1], last !== null);
    if (kind === null) {
      flush();
      if (w in PLURAL_SCALES) out.push(String(PLURAL_SCALES[w]));
      else if (ORDINALS.has(w) || (/\d/.test(w) && /\p{L}/u.test(w))) out.push(w);
      return;
    }
    if (last !== null && !FOLLOWS[last].includes(kind)) flush();
    if (kind === 'digits') current = Number(w);
    else if (kind === 'unit') current += UNITS[w] ?? 1;
    else if (kind === 'tens') current += TENS[w]!;
    else if (kind === 'multiplier') current = (current || 1) * MULTIPLIERS[w]!;
    else if (kind === 'scale') {
      total += (current || 1) * SCALES[w]!;
      current = 0;
    }
    last = kind;
  });
  flush();
  return out.sort();
}

export function negationCount(words: readonly string[]): number {
  return words.filter((w) => NEGATIONS.has(w)).length;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Words that pin down when: "by the end of this year" and "by the start of
// next year" differ in only two tokens, well inside the fuzzy-match budget.
const TIME_WORDS = new Set([
  'this', 'next', 'last', 'previous', 'early', 'mid', 'middle', 'late', 'end', 'start', 'beginning',
  'today', 'tonight', 'tomorrow', 'yesterday', 'soon', 'now',
  'day', 'week', 'month', 'quarter', 'half', 'year', 'decade', 'century',
  'spring', 'summer', 'fall', 'autumn', 'winter',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

function singular(w: string): string {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/** Time words ("next", "year", "march") in order, plurals folded ("years" -> "year"). */
export function timeWords(words: readonly string[]): string[] {
  return words.map(singular).filter((w) => TIME_WORDS.has(w));
}

/** Why `span` says something different from `quote`, or null when numbers and negations agree. */
export function meaningChange(quote: readonly string[], span: readonly string[]): string | null {
  const qNums = numberSignature(quote);
  const sNums = numberSignature(span);
  if (!sameList(qNums, sNums)) {
    return `number mismatch: quote has [${qNums.join(', ')}], transcript has [${sNums.join(', ')}]`;
  }
  const qNeg = negationCount(quote);
  const sNeg = negationCount(span);
  if (qNeg !== sNeg) return `negation mismatch: quote has ${qNeg} negation(s), transcript has ${sNeg}`;
  return null;
}

/** Why a near-match quote gives a different time than the transcript, or null when the time words agree. */
export function timeChange(quote: readonly string[], span: readonly string[]): string | null {
  const qTime = timeWords(quote);
  const sTime = timeWords(span);
  if (sameList(qTime, sTime)) return null;
  return `time mismatch: quote has [${qTime.join(', ')}], transcript has [${sTime.join(', ')}]`;
}

// ---- Approximate matching -----------------------------------------------

interface Span {
  start: number; // token index, inclusive
  end: number; // token index, exclusive
  distance: number;
}

/**
 * Word-level approximate substring search (Sellers): every transcript span
 * whose edit distance to the quote is <= maxDistance, as [start, end) token
 * ranges, plus the best distance seen anywhere (for the rejection score).
 */
function approximateSpans(quote: readonly string[], words: readonly string[], maxDistance: number): { spans: Span[]; best: number } {
  const n = quote.length;
  let prev = new Int32Array(n + 1);
  let prevStart = new Int32Array(n + 1);
  let cur = new Int32Array(n + 1);
  let curStart = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) prev[i] = i;
  const spans: Span[] = [];
  let best = n;
  for (let j = 1; j <= words.length; j++) {
    const word = words[j - 1];
    cur[0] = 0;
    curStart[0] = j;
    for (let i = 1; i <= n; i++) {
      let d = prev[i - 1]! + (quote[i - 1] === word ? 0 : 1);
      let s = i === 1 ? j - 1 : prevStart[i - 1]!;
      if (prev[i]! + 1 < d) {
        d = prev[i]! + 1;
        s = prevStart[i]!;
      }
      if (cur[i - 1]! + 1 < d) {
        d = cur[i - 1]! + 1;
        s = curStart[i - 1]!;
      }
      cur[i] = d;
      curStart[i] = s;
    }
    best = Math.min(best, cur[n]!);
    if (cur[n]! <= maxDistance && curStart[n]! < j) spans.push({ start: curStart[n]!, end: j, distance: cur[n]! });
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }
  return { spans, best };
}

/** Plain word-level edit distance, for re-scoring a trimmed span. */
function editDistance(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

// A span that reaches into a neighbouring line (the model copied a label or
// the end of the host's question) may still hold a valid span inside one
// line: offer each single-segment piece that stays within the edit budget.
function segmentTrims(span: Span, tokens: readonly Token[], quote: readonly string[], words: readonly string[], maxDistance: number): Span[] {
  const out: Span[] = [];
  let a = span.start;
  while (a < span.end) {
    let b = a + 1;
    while (b < span.end && tokens[b]!.region === tokens[a]!.region) b++;
    if (a > span.start || b < span.end) {
      const distance = editDistance(quote, words.slice(a, b));
      if (distance <= maxDistance) out.push({ start: a, end: b, distance });
    }
    a = b;
  }
  return out;
}

/** Every candidate span (plus single-line trims), best first: fewest edits, closest length, earliest. */
function rankedCandidates(spans: Span[], tokens: readonly Token[], quote: readonly string[], words: readonly string[], maxDistance: number): Span[] {
  const all = [...spans, ...spans.flatMap((sp) => segmentTrims(sp, tokens, quote, words, maxDistance))];
  const seen = new Set<string>();
  return all
    .filter((sp) => {
      const key = `${sp.start}:${sp.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        Math.abs(a.end - a.start - quote.length) - Math.abs(b.end - b.start - quote.length) ||
        a.start - b.start,
    );
}

// ---- Named entities ------------------------------------------------------

// A capitalized word that is not the first word of a sentence or line is
// taken as a name ("Europe", "Optimus"). "I" and its contractions are not.
function isEntity(text: string, tok: Pick<Token, 'start' | 'end'>): boolean {
  const word = text.slice(tok.start, tok.end);
  if (!/^\p{Lu}/u.test(word) || /\d/.test(word) || /^I(?:['‘’ʼ].*)?$/.test(word)) return false;
  const before = text.slice(0, tok.start).replace(/[\s"“”'‘’(\[-]+$/u, '');
  return before !== '' && !/[.!?:\n]$/.test(before);
}

function entityWords(text: string, tokens: readonly Token[]): string[] {
  return [...new Set(tokens.filter((tok) => isEntity(text, tok)).map((tok) => tok.norm))];
}

// Spelling variants of one name ("Monterey" / "Monterrey") are an ASR slip,
// not a different place: allow one character edit per four letters.
function sameNameSpelling(a: string, b: string): boolean {
  return a === b || editDistance([...a], [...b]) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 4));
}

/**
 * Why a near match names a different thing ("Asia" for "Europe"), or null.
 * Each side's capitalized names must appear among the other side's words;
 * lowercase auto-captions carry no names, so only the quote's are checked then.
 */
function entityChange(quote: string, qTokens: readonly Token[], t: Transcript, spanTokens: readonly Token[]): string | null {
  const qWords = qTokens.map((tok) => tok.norm);
  const sWords = spanTokens.map((tok) => tok.norm);
  const onOtherSide = (w: string, other: readonly string[]) => other.some((o) => sameNameSpelling(w, o));
  const missing = [
    ...entityWords(quote, qTokens).filter((w) => !onOtherSide(w, sWords)),
    ...entityWords(t.text, spanTokens).filter((w) => !onOtherSide(w, qWords)),
  ];
  return missing.length ? `name mismatch: [${missing.join(', ')}] is not on both sides` : null;
}

// ---- Speakers and output ------------------------------------------------

function speakerWords(name: string): string[] {
  return normalizeForMatch(name).split(' ').filter(Boolean);
}

// Diarization labels like "Speaker 1" say nothing about who is talking.
function isAnonymousLabel(label: string): boolean {
  return /^(?:speaker|spk|voice|person|unknown|participant)\s*[a-z]?\s*\d*$/i.test(label.trim());
}

// "Host", "Interviewer", "Q": the line is the interviewer's, never the guest's.
function isInterviewerRole(label: string): boolean {
  return /^(?:host|co-?host|interviewer|moderator|anchor|presenter|q|question)\s*\d*$/i.test(label.trim());
}

// "Guest", "Interviewee", "A": the answering side of an interview, which is
// who an ingest names as the speaker.
function isAnswerRole(label: string): boolean {
  return /^(?:guest|interviewee|a|answer)\s*\d*$/i.test(label.trim());
}

/** "Dana" matches "Dana Founder"; "Sam Host" does not. */
export function sameSpeaker(label: string, name: string): boolean {
  const a = speakerWords(label);
  const b = speakerWords(name);
  if (a.length === 0 || b.length === 0) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((w) => long.includes(w));
}

function spanSpeakers(t: Transcript, tokens: readonly Token[]): string[] {
  const names = new Set<string>();
  for (const token of tokens) {
    const name = t.segments[token.region]?.speaker?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

function sameName(a: string, b: string): boolean {
  return speakerWords(a).join(' ') === speakerWords(b).join(' ');
}

/** Why a line labeled `label` cannot be `wanted`'s words, or null when it can. */
export function labelProblem(label: string, wanted: string | undefined, host?: string): string | null {
  const isWanted = wanted !== undefined && sameName(label, wanted);
  // "Dana" is ambiguous when the host is "Dana Smith" and the guest "Dana Founder".
  if (host && !isWanted && sameSpeaker(label, host)) return `quote is in a line by ${label}, the host`;
  if (!wanted || isWanted || isAnonymousLabel(label)) return null;
  if (isInterviewerRole(label)) return `quote is in a line labeled ${label}, the interviewer, not ${wanted}`;
  if (isAnswerRole(label) || sameSpeaker(label, wanted)) return null;
  return `quote is in a line by ${label}, not ${wanted}`;
}

function speakerProblem(speakers: readonly string[], wanted: string | undefined, host: string | undefined): string | null {
  if (speakers.length > 1) return `quote runs across lines by ${speakers.join(' and ')}`;
  const label = speakers[0];
  return label ? labelProblem(label, wanted, host) : null;
}

// Verbatim words of the span, one slice per segment so labels in between are
// left out; whitespace (line breaks between caption cues) collapses to spaces.
function originalText(t: Transcript, tokens: readonly Token[]): string {
  const pieces: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    while (j + 1 < tokens.length && tokens[j + 1]!.region === tokens[i]!.region) j++;
    pieces.push(t.text.slice(tokens[i]!.start, tokens[j]!.end));
    i = j + 1;
  }
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

function roundScore(x: number): number {
  return Math.round(Math.max(0, x) * 1000) / 1000;
}

/** YouTube watch/short links jump to `sec` with t=<sec>s; other hosts get no deep link. */
export function deepLinkFor(url: string, sec?: number): string | undefined {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^(?:www|m|music)\./, '');
  const isWatch = host === 'youtube.com' && u.pathname === '/watch' && u.searchParams.has('v');
  const isShort = host === 'youtu.be' && u.pathname.length > 1;
  if (!isWatch && !isShort) return undefined;
  u.searchParams.set('t', `${Math.floor(sec)}s`);
  return u.toString();
}

/** The quote without a leading "Dana Founder: " naming the speaker (models copy the line label). */
export function withoutSpeakerLabel(quote: string, speaker: string | undefined): string {
  const m = /^\s*([^:\n]{1,60}):\s+(?=\S)/.exec(quote);
  return m && speaker && sameSpeaker(m[1]!, speaker) ? quote.slice(m[0].length) : quote;
}

/**
 * Find `quote` in the transcript. Exact after normalization scores 1; else
 * the closest span within MIN_QUOTE_SCORE (token edit distance) counts, as
 * long as its numbers, negations, time words, names and speaker agree with
 * the quote. Every candidate span is tried, best first, so a near place that
 * fails a check never hides a valid one next to it.
 */
export function checkQuote(rawQuote: string, t: Transcript, opts: QuoteCheckOptions = {}): QuoteMatch {
  const minScore = opts.minScore ?? MIN_QUOTE_SCORE;
  const quote = withoutSpeakerLabel(rawQuote, opts.speaker);
  const qTokens = tokensOf(quote);
  const q = qTokens.map((tok) => tok.norm);
  if (q.length === 0) return { verified: false, score: 0, reason: 'empty quote' };

  const tokens = transcriptTokens(t);
  const words = tokens.map((tok) => tok.norm);
  const maxDistance = Math.floor(q.length * (1 - minScore) + 1e-9);
  const { spans, best } = approximateSpans(q, words, maxDistance);
  if (spans.length === 0) {
    const score = roundScore(1 - best / q.length);
    return { verified: false, score, reason: `not found in transcript (closest match scores ${score}, need ${minScore})` };
  }

  let firstProblem: { score: number; reason: string } | undefined;
  for (const place of rankedCandidates(spans, tokens, q, words, maxDistance)) {
    const spanTokens = tokens.slice(place.start, place.end);
    const spanWords = words.slice(place.start, place.end);
    const score = roundScore(1 - place.distance / q.length);
    const speakers = spanSpeakers(t, spanTokens);
    const problem =
      speakerProblem(speakers, opts.speaker, opts.host) ??
      meaningChange(q, spanWords) ??
      (place.distance > 0 ? (timeChange(q, spanWords) ?? entityChange(quote, qTokens, t, spanTokens)) : null);
    if (problem) {
      firstProblem ??= { score, reason: problem };
      continue;
    }
    const charOffset = spanTokens[0]!.start;
    const endOffset = spanTokens[spanTokens.length - 1]!.end;
    const match: QuoteMatch = { verified: true, matchedText: originalText(t, spanTokens), charOffset, endOffset, score };
    const sec = startSecAtChar(t, charOffset);
    if (sec !== undefined) match.timestampSec = Math.floor(sec);
    const link = t.meta.url ? deepLinkFor(t.meta.url, sec) : undefined;
    if (link) match.deepLink = link;
    if (speakers[0]) match.speaker = speakers[0];
    return match;
  }
  return { verified: false, ...firstProblem! };
}
