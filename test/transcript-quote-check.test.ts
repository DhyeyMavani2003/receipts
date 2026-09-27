import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  checkQuote,
  deepLinkFor,
  labelProblem,
  meaningChange,
  negationCount,
  normalizeForMatch,
  numberSignature,
  sameSpeaker,
  timeWords,
  withoutSpeakerLabel,
} from '../src/quote-check.ts';
import { buildText } from '../src/transcript/chunk.ts';
import { loadTranscript, parsePlain, parseVtt } from '../src/transcript/load.ts';
import type { Segment, Transcript } from '../src/types.ts';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'transcripts');
const YT_URL = 'https://www.youtube.com/watch?v=SYNTH000001';

let interview: Transcript;
let captions: Transcript;

beforeAll(async () => {
  interview = await loadTranscript(join(FIXTURES, 'synthetic-interview.txt'), { date: '2025-01-15' });
  captions = await loadTranscript(join(FIXTURES, 'synthetic-youtube.en.vtt'), { url: YT_URL });
});

function segmentWith(t: Transcript, words: string): Segment {
  const seg = t.segments.find((s) => s.text.includes(words));
  if (!seg) throw new Error(`fixture has no segment with "${words}"`);
  return seg;
}

const words = (s: string) => normalizeForMatch(s).split(' ');

describe('normalizeForMatch', () => {
  test.each([
    ['“Uh, we WON’T — you know — ship 1,000 robots!”', 'we wont ship 1000 robots'],
    ["It's  self-driving,   um, (mostly).", 'its self driving mostly'],
    ['Growth of 50% in Q3', 'growth of 50 percent in q3'],
    ['The U.S. market, 1.5 billion', 'the u s market 1.5 billion'],
    ['Café naïve', 'cafe naive'],
    ['', ''],
  ])('%p -> %p', (input, expected) => {
    expect(normalizeForMatch(input)).toBe(expected);
  });
});

describe('numberSignature / negationCount', () => {
  test('digits and number words agree', () => {
    expect(numberSignature(words('ten thousand robots'))).toEqual(numberSignature(words('10,000 robots')));
    expect(numberSignature(words('1.1 million'))).toEqual(numberSignature(words('1,100,000')));
    expect(numberSignature(words('two hundred and fifty'))).toEqual(['250']);
    expect(numberSignature(words('a million'))).toEqual(['1000000']);
    expect(numberSignature(words('twenty five thousand'))).toEqual(['25000']);
    expect(numberSignature(words('2 million 500 thousand'))).toEqual(['2500000']);
  });

  test('changed numbers differ', () => {
    expect(numberSignature(words('a million'))).not.toEqual(numberSignature(words('a thousand')));
    expect(numberSignature(words('the F2 in 2025'))).not.toEqual(numberSignature(words('the F3 in 2025')));
    expect(numberSignature(words('thousands of robots'))).not.toEqual(numberSignature(words('millions of robots')));
    expect(numberSignature(words('the second quarter'))).not.toEqual(numberSignature(words('the third quarter')));
  });

  test('separate numbers stay separate', () => {
    expect(numberSignature(words('between 2027 and 2028'))).toEqual(['2027', '2028']);
    expect(numberSignature(words('one two three'))).toEqual(['1', '2', '3']);
    expect(numberSignature(words('no numbers here'))).toEqual([]);
  });

  test('negations', () => {
    expect(negationCount(words("we won't ship"))).toBe(1);
    expect(negationCount(words('we will ship'))).toBe(0);
    expect(negationCount(words('not now, never, cannot'))).toBe(3);
    expect(meaningChange(words('we will ship'), words("we won't ship"))).toMatch(/negation/);
    expect(meaningChange(words('a million'), words('a thousand'))).toMatch(/number/);
    expect(meaningChange(words('We will ship.'), words('we will ship'))).toBeNull();
  });
});

describe('checkQuote: accepts what transcription and copying change', () => {
  test('exact quote from mid-segment: score 1, original text, speaker, timestamp', () => {
    const quote = 'we will ship ten thousand F2 robots by the end of 2025, for sure';
    const m = checkQuote(quote, interview);
    expect(m.verified).toBe(true);
    expect(m.score).toBe(1);
    expect(m.matchedText).toBe(quote);
    expect(interview.text.slice(m.charOffset!, m.charOffset! + quote.length)).toBe(quote);
    expect(m.speaker).toBe('Dana Founder');
    expect(m.timestampSec).toBe(segmentWith(interview, quote).start!);
    expect(m.deepLink).toBeUndefined(); // no URL on this transcript
  });

  test('punctuation, casing and curly quotes', () => {
    const m = checkQuote('“We Will ship ten-thousand F2 robots by the end of 2025 — FOR SURE.”', interview);
    expect(m).toMatchObject({ verified: true, score: 1 });
    expect(m.matchedText).toBe('we will ship ten thousand F2 robots by the end of 2025, for sure');
  });

  test('filler words on either side', () => {
    const noFiller = checkQuote('the parts are ordered, and the customers are already waiting for them', interview);
    expect(noFiller).toMatchObject({ verified: true, score: 1 });
    expect(noFiller.matchedText).toBe('the parts are ordered, and, you know, the customers are already waiting for them');
    const extraFiller = checkQuote('um, it can learn a new warehouse task from a few hours of, uh, human demonstration', interview);
    expect(extraFiller).toMatchObject({ verified: true, score: 1 });
  });

  test('a small ASR slip still verifies, and matchedText is the transcript wording', () => {
    const m = checkQuote('Our second factory, in Monterey, will probably open by the middle of 2026.', interview);
    expect(m.verified).toBe(true);
    expect(m.score).toBeGreaterThanOrEqual(0.85);
    expect(m.score).toBeLessThan(1);
    expect(m.matchedText).toBe('Our second factory, in Monterrey, will probably open by the middle of 2026');
  });

  test('a dropped word is an edit too', () => {
    const m = checkQuote('Half of our revenue will come from outside the United States by end of 2027, definitely', interview);
    expect(m.verified).toBe(true);
    expect(m.matchedText).toBe('Half of our revenue will come from outside the United States by the end of 2027, definitely');
  });

  test('quote across YouTube caption lines, with deep link', () => {
    const m = checkQuote('This year we will ship ten thousand of them, for sure.', captions);
    expect(m.verified).toBe(true);
    expect(m.matchedText).toBe('this year we will ship ten thousand of them for sure');
    const line = segmentWith(captions, 'year and this year we will ship');
    expect(m.timestampSec).toBe(Math.floor(line.start!));
    expect(m.deepLink).toBe(`${YT_URL}&t=${Math.floor(line.start!)}s`);
  });

  test('transcript with no segments', () => {
    const t: Transcript = { text: 'We will, uh, definitely ship it next year.', segments: [], meta: {} };
    expect(checkQuote('we will definitely ship it next year', t)).toMatchObject({ verified: true, score: 1, charOffset: 0 });
  });
});

describe('checkQuote: rejects changed meaning', () => {
  test('changed number word ("a million" -> "a thousand")', () => {
    const m = checkQuote('A thousand home robots by 2027 is not going to happen, not from us and not from anybody else.', interview);
    expect(m.verified).toBe(false);
    expect(m.score).toBeGreaterThanOrEqual(0.85); // close enough textually...
    expect(m.reason).toMatch(/number mismatch/); // ...but the number changed
    expect(m.matchedText).toBeUndefined();
  });

  test('changed digits and scale', () => {
    expect(checkQuote('we will ship ten thousand F2 robots by the end of 2026, for sure', interview).reason).toMatch(/number/);
    expect(checkQuote('we will ship ten million F2 robots by the end of 2025, for sure', interview).reason).toMatch(/number/);
    expect(checkQuote('this year we will ship ten million of them for sure', captions).verified).toBe(false);
  });

  test('"will" -> "won\'t"', () => {
    const m = checkQuote("Half of our revenue won't come from outside the United States by the end of 2027, definitely.", interview);
    expect(m.verified).toBe(false);
    expect(m.reason).toMatch(/negation mismatch/);
  });

  test('dropped "not"', () => {
    const m = checkQuote('A million home robots by 2027 is going to happen, not from us and not from anybody else.', interview);
    expect(m.verified).toBe(false);
    expect(m.reason).toMatch(/negation/);
  });

  test('"won\'t" -> "will" in captions', () => {
    const m = checkQuote('it will be cheap at first, maybe twenty thousand dollars', captions);
    expect(m.verified).toBe(false);
    expect(m.reason).toMatch(/negation/);
  });

  test('words that were never said', () => {
    const m = checkQuote('We will put a Ferrowind robot on the Moon before 2030.', interview);
    expect(m.verified).toBe(false);
    expect(m.score).toBeLessThan(0.85);
    expect(m.reason).toMatch(/not found/);
  });

  test('empty quote', () => {
    expect(checkQuote(' … ', interview)).toEqual({ verified: false, score: 0, reason: 'empty quote' });
  });
});

describe('checkQuote: speakers', () => {
  const hostQuestion = "Ferrowind will have a million robots in people's homes by 2027";

  test("the host's leading question is attributed to the host", () => {
    expect(checkQuote(hostQuestion, interview)).toMatchObject({ verified: true, speaker: 'Sam Host' });
  });

  test('with opts.speaker, a line by someone else is rejected', () => {
    const m = checkQuote(hostQuestion, interview, { speaker: 'Dana Founder' });
    expect(m.verified).toBe(false);
    expect(m.reason).toMatch(/Sam Host, not Dana Founder/);
  });

  test('a quote running across two speakers is rejected', () => {
    const m = checkQuote('Thanks for coming on. Thanks, Sam. This was fun.', interview);
    expect(m.verified).toBe(false);
    expect(m.reason).toMatch(/across lines by Sam Host and Dana Founder/);
  });

  test("the guest's words pass for the guest, even when the host repeated them first", () => {
    const segments: Segment[] = [
      { start: 0, speaker: 'Sam Host', text: 'You said we will ship ten thousand robots next year?' },
      { start: 9, speaker: 'Dana Founder', text: 'Yes, we will ship ten thousand robots next year.' },
    ];
    const t: Transcript = { text: buildText(segments).text, segments, meta: {} };
    const m = checkQuote('We will ship ten thousand robots next year', t, { speaker: 'Dana' });
    expect(m).toMatchObject({ verified: true, speaker: 'Dana Founder', timestampSec: 9 });
    expect(m.matchedText).toBe('we will ship ten thousand robots next year');
  });

  test('generic diarization labels are not held against the speaker', () => {
    const segments: Segment[] = [{ start: 3, speaker: 'Speaker 2', text: 'We will ship ten thousand robots next year.' }];
    const t: Transcript = { text: buildText(segments).text, segments, meta: {} };
    expect(checkQuote('we will ship ten thousand robots next year', t, { speaker: 'Dana Founder' }).verified).toBe(true);
  });

  test('sameSpeaker', () => {
    expect(sameSpeaker('Dana', 'Dana Founder')).toBe(true);
    expect(sameSpeaker('DANA FOUNDER', 'Dana Founder')).toBe(true);
    expect(sameSpeaker('Sam Host', 'Dana Founder')).toBe(false);
    expect(sameSpeaker('', 'Dana Founder')).toBe(false);
  });
});

describe('deepLinkFor', () => {
  test.each([
    ['https://www.youtube.com/watch?v=abc123', 95, 'https://www.youtube.com/watch?v=abc123&t=95s'],
    ['https://youtube.com/watch?v=abc123&t=10s', 95.9, 'https://youtube.com/watch?v=abc123&t=95s'],
    ['https://m.youtube.com/watch?v=abc123', 0, 'https://m.youtube.com/watch?v=abc123&t=0s'],
    ['https://youtu.be/abc123', 61, 'https://youtu.be/abc123?t=61s'],
  ])('%p at %p s', (url, sec, expected) => {
    expect(deepLinkFor(url, sec)).toBe(expected);
  });

  test.each([
    ['https://example.com/episode-12', 30],
    ['https://www.youtube.com/@somechannel', 30],
    ['not a url', 30],
    ['https://www.youtube.com/watch?v=abc123', undefined],
    ['https://www.youtube.com/watch?v=abc123', -1],
  ])('no deep link for %p at %p', (url, sec) => {
    expect(deepLinkFor(url, sec)).toBeUndefined();
  });
});

describe('checkQuote performance', () => {
  test('a 3-hour-sized transcript checks in well under a second', () => {
    const filler = interview.segments.filter((s) => s.speaker === 'Sam Host');
    const segments: Segment[] = [];
    for (let i = 0; i < 40; i++) segments.push(...filler.map((s) => ({ ...s, start: (s.start ?? 0) + i * 1000 })));
    segments.push({ start: 99_999, speaker: 'Dana Founder', text: 'The needle: we will open nine factories by 2031.' });
    const t: Transcript = { text: buildText(segments).text, segments, meta: {} };
    const began = performance.now();
    const m = checkQuote('we will open nine factories by 2031', t, { speaker: 'Dana Founder' });
    expect(m).toMatchObject({ verified: true, timestampSec: 99_999 });
    expect(performance.now() - began).toBeLessThan(1500);
  });
});

describe('checkQuote: interviewer roles and the host', () => {
  const hostLine = 'So you will ship ten thousand robots by the end of 2025, right?';
  const dialogue = (hostLabel: string, guestLabel = 'Dana Founder') =>
    parsePlain(
      [
        `${hostLabel}: Welcome back to the show.`,
        `${guestLabel}: Thanks for having me.`,
        `${hostLabel}: ${hostLine}`,
        `${guestLabel}: We are focused on quality first and the numbers will follow.`,
      ].join('\n'),
    );
  const transcriptOf = (segments: Segment[]): Transcript => ({ text: buildText(segments).text, segments, meta: {} });

  test.each(['Host', 'Interviewer', 'Q', 'Moderator'])('a line labeled %p is never the guest\'s', (label) => {
    const m = checkQuote(hostLine, transcriptOf(dialogue(label)), { speaker: 'Dana Founder' });
    expect(m.verified).toBe(false);
    expect(m.reason).toMatch(/the interviewer/);
  });

  test('a control: a named host line is rejected too', () => {
    expect(checkQuote(hostLine, transcriptOf(dialogue('Sam Host')), { speaker: 'Dana Founder' }).verified).toBe(false);
  });

  test('answer roles and anonymous diarization labels still pass for the guest', () => {
    const t = transcriptOf(dialogue('Q', 'A'));
    const answer = 'We are focused on quality first and the numbers will follow.';
    expect(checkQuote(answer, t, { speaker: 'Dana Founder' }).verified).toBe(true);
    expect(checkQuote(answer, transcriptOf(dialogue('Speaker 1', 'Speaker 2')), { speaker: 'Dana Founder' }).verified).toBe(true);
  });

  test('ingesting the role itself is allowed', () => {
    expect(checkQuote(hostLine, transcriptOf(dialogue('Host')), { speaker: 'Host' }).verified).toBe(true);
  });

  test('opts.host rejects lines labeled with the host, even a shared first name', () => {
    const segments: Segment[] = [
      { speaker: 'Dana', text: 'We will ship ten thousand robots next year, won\'t you?' },
      { speaker: 'Dana Founder', text: 'Maybe. Revenue will double by 2027.' },
    ];
    const t = transcriptOf(segments);
    const m = checkQuote("We will ship ten thousand robots next year, won't you?", t, { speaker: 'Dana Founder', host: 'Dana Smith' });
    expect(m).toMatchObject({ verified: false });
    expect(m.reason).toMatch(/the host/);
    expect(checkQuote('Revenue will double by 2027.', t, { speaker: 'Dana Founder', host: 'Dana Smith' }).verified).toBe(true);
  });

  test('labelProblem', () => {
    expect(labelProblem('Host', 'Dana Founder')).toMatch(/interviewer/);
    expect(labelProblem('Guest', 'Dana Founder')).toBeNull();
    expect(labelProblem('Speaker 2', 'Dana Founder')).toBeNull();
    expect(labelProblem('Host', undefined)).toBeNull();
    expect(labelProblem('Sam', 'Dana Founder', 'Sam Host')).toMatch(/the host/);
  });
});

describe('checkQuote: near matches must keep time words and names', () => {
  const segments: Segment[] = [
    { start: 0, speaker: 'Dana Founder', text: 'We will start selling the F2 to customers in Europe by the end of next year, and we are hiring now.' },
  ];
  const t: Transcript = { text: buildText(segments).text, segments, meta: {} };

  test('the exact words verify', () => {
    expect(checkQuote('We will start selling the F2 to customers in Europe by the end of next year, and we are hiring now.', t).verified).toBe(true);
  });

  test('"this year" for "next year" is rejected', () => {
    const m = checkQuote('We will start selling the F2 to customers in Europe by the end of this year, and we are hiring now.', t);
    expect(m.verified).toBe(false);
    expect(m.reason).toMatch(/time mismatch/);
  });

  test('"Asia" for "Europe" is rejected', () => {
    const m = checkQuote('We will start selling the F2 to customers in Asia by the end of next year, and we are hiring now.', t);
    expect(m.verified).toBe(false);
    expect(m.reason).toMatch(/name mismatch/);
  });

  test('timeWords folds plurals', () => {
    expect(timeWords(words('in two years or three months'))).toEqual(['year', 'month']);
  });
});

describe('checkQuote: every candidate span is tried', () => {
  const segments: Segment[] = [
    { start: 0, speaker: 'Sam Host', text: 'How many robots will you ship next year, Dana Founder?' },
    { start: 5, speaker: 'Dana Founder', text: 'We will ship ten thousand F2 robots to paying customers in the United States next year, for sure.' },
  ];
  const t: Transcript = { text: buildText(segments).text, segments, meta: {} };
  const guestWords = 'We will ship ten thousand F2 robots to paying customers in the United States next year, for sure';

  test('a span reaching into the host line falls back to the guest line inside it', () => {
    // "Founder, we will ..." matches exactly across the two lines; the guest-only span is one edit away.
    const m = checkQuote(`Founder, ${guestWords}.`, t, { speaker: 'Dana Founder' });
    expect(m).toMatchObject({ verified: true, speaker: 'Dana Founder', timestampSec: 5, matchedText: guestWords });
    expect(m.score).toBeLessThan(1);
    expect(t.text.slice(m.charOffset, m.endOffset)).toBe(guestWords);
  });

  test('a leading "Speaker Name:" label on the quote is ignored', () => {
    expect(withoutSpeakerLabel(`Dana Founder: ${guestWords}`, 'Dana Founder')).toBe(guestWords);
    expect(withoutSpeakerLabel(`Sam Host: ${guestWords}`, 'Dana Founder')).toBe(`Sam Host: ${guestWords}`);
    const m = checkQuote(`Dana Founder: ${guestWords}.`, t, { speaker: 'Dana Founder' });
    expect(m).toMatchObject({ verified: true, score: 1, speaker: 'Dana Founder', matchedText: guestWords });
  });
});

describe('checkQuote over voiced VTT cues', () => {
  test("the second line of the host's cue is still the host's", () => {
    const segments = parseVtt(
      'WEBVTT\n\n00:00:01.000 --> 00:00:05.000\n<v Sam Host>So tell me about the plan.\nWe will ship ten thousand robots by the end of 2025.\n',
    );
    const t: Transcript = { text: buildText(segments).text, segments, meta: {} };
    const m = checkQuote('We will ship ten thousand robots by the end of 2025.', t, { speaker: 'Dana Founder' });
    expect(m.verified).toBe(false);
    expect(m.reason).toMatch(/Sam Host, not Dana Founder/);
  });
});
