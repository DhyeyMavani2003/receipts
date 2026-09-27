import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  EXTRACT_CONCURRENCY,
  EXTRACT_SYSTEM,
  dedupeClaims,
  extractClaims,
  extractUserPrompt,
  groundingProblem,
  joinProductCodes,
  hedgeNearQuote,
  isCalendarDate,
  isNearDuplicate,
  mapLimit,
  topicsForSpeaker,
  zExtractClaims,
} from '../src/extract.ts';
import type { ExtractOptions, ExtractedClaim, ProgressEvent } from '../src/extract.ts';
import { claimId } from '../src/ledger.ts';
import { MockLLM } from '../src/llm/mock.ts';
import type { JsonRequest } from '../src/llm/provider.ts';
import { toOpenAISchema } from '../src/llm/schema.ts';
import { buildText } from '../src/transcript/chunk.ts';
import { loadTranscript } from '../src/transcript/load.ts';
import type { Segment, SourceRef, Transcript } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

const TRANSCRIPT = join(import.meta.dir, '..', 'fixtures', 'transcripts', 'synthetic-interview.txt');
const SOURCE: SourceRef = { title: 'The Build Log #42', url: 'https://example.com/ep42', date: '2025-01-15', kind: 'podcast' };
const OPTS: ExtractOptions = { speaker: 'Dana Founder', host: 'Sam Host', source: SOURCE };

let interview: Transcript;
beforeAll(async () => {
  interview = await loadTranscript(TRANSCRIPT);
});

function candidate(over: Partial<ExtractedClaim> & Pick<ExtractedClaim, 'quote' | 'claim'>): ExtractedClaim {
  return {
    type: 'prediction',
    topic: 'ferrowind-f2-shipments',
    targetDate: null,
    targetDateInferred: false,
    resolutionCriteria: 'Observable outcome.',
    hedge: '',
    specificity: 3,
    ...over,
  };
}

const TEN_K = candidate({
  quote: "So I'll say it plainly: we will ship ten thousand F2 robots by the end of 2025, for sure.",
  claim: 'Ferrowind Robotics will ship 10,000 F2 robots by the end of 2025.',
  targetDate: '2025-12-31',
  hedge: 'for sure',
  specificity: 4,
});
// Same claim reworded, more specific: replaces TEN_K.
const TEN_K_SHARPER = { ...TEN_K, claim: 'Ferrowind will ship 10,000 F2 humanoid robots by the end of 2025.', specificity: 5 };

const CHUNK_1: ExtractedClaim[] = [
  TEN_K,
  // Copying slips (an added filler word, no final period) still verify.
  candidate({
    quote: 'Our second factory, in Monterrey, will, um, probably open by the middle of 2026',
    claim: 'Ferrowind Robotics will open its second factory, in Monterrey, by the middle of 2026.',
    topic: 'Ferrowind Monterrey Factory',
    targetDate: '2026-06-30',
    hedge: '"probably"',
    specificity: 5,
  }),
  candidate({
    quote: 'We will put a Ferrowind robot in every American home by 2026, guaranteed.',
    claim: 'Ferrowind will put a robot in every American home by 2026.',
    targetDate: '2026-12-31',
    hedge: 'guaranteed',
  }),
  candidate({
    quote: "So you're saying Ferrowind will have a million robots in people's homes by 2027?",
    claim: 'Ferrowind will have one million robots in homes by 2027.',
    targetDate: '2027-12-31',
  }),
  candidate({
    quote: 'we will ship twenty thousand F2 robots by the end of 2025',
    claim: 'Ferrowind will ship 20,000 F2 robots by the end of 2025.',
    targetDate: '2025-12-31',
  }),
  { ...TEN_K, specificity: 2 },
  TEN_K_SHARPER,
  candidate({
    quote: "Maybe by 2030 you'll be able to buy a home robot for less than ten thousand dollars.",
    claim: 'A home robot will be available for less than $10,000 by 2030.',
    topic: 'home-robot-price',
    targetDate: '2030-12-31',
    hedge: 'coin flip',
  }),
  candidate({
    quote: 'We might go public in 2027.',
    claim: 'Ferrowind Robotics will go public in 2027.',
    topic: 'ferrowind-ipo',
    targetDate: '2027-12-31',
    hedge: 'definitely',
  }),
  candidate({
    quote: "I'm against a robot tax.",
    claim: 'Governments should not tax robots that replace workers.',
    type: 'stance',
    topic: 'robot-tax',
    targetDate: '2030-12-31',
    targetDateInferred: true,
  }),
  candidate({
    quote: 'The F3 will launch at our developer day in March 2026',
    claim: 'Ferrowind Robotics will launch the F3 at its developer day in March 2026.',
    topic: 'ferrowind-f3-launch',
    targetDate: '2026-02-30',
  }),
];

const CHUNK_2: ExtractedClaim[] = [
  TEN_K,
  candidate({
    quote: 'I think the work changes more than the headcount.',
    claim: "Automation at Ferrowind's customers will change warehouse work more than it reduces headcount.",
    type: 'stance',
    topic: 'automation-jobs',
    hedge: 'I think',
  }),
];

function interviewModel() {
  return new MockLLM((req) => ({ claims: req.user.includes('part 1 (') ? CHUNK_1 : CHUNK_2 }));
}

describe('extractClaims on the synthetic interview', () => {
  let result: Awaited<ReturnType<typeof extractClaims>>;
  let llm: MockLLM;
  const events: ProgressEvent[] = [];

  beforeAll(async () => {
    llm = interviewModel();
    result = await extractClaims(interview, llm, { ...OPTS, onProgress: (e) => events.push(e) });
  });

  test('keeps verified speaker quotes, deduped, in transcript order', () => {
    expect(result.claims.map((c) => c.claim)).toEqual([
      TEN_K_SHARPER.claim,
      'Ferrowind Robotics will open its second factory, in Monterrey, by the middle of 2026.',
      'A home robot will be available for less than $10,000 by 2030.',
      'Ferrowind Robotics will go public in 2027.',
      'Governments should not tax robots that replace workers.',
      'Ferrowind Robotics will launch the F3 at its developer day in March 2026.',
      "Automation at Ferrowind's customers will change warehouse work more than it reduces headcount.",
    ]);
    expect(result.claims.every((c) => c.quoteVerified && c.verdict === 'pending' && c.origin === 'extracted')).toBe(true);
  });

  test('drops hallucinated quotes, host lines and changed numbers, with reasons', () => {
    expect(result.dropped).toHaveLength(3);
    const reasons = Object.fromEntries(result.dropped.map((d) => [d.quote.slice(0, 20), d.reason]));
    expect(reasons['We will put a Ferrow']).toMatch(/not found in transcript/);
    expect(reasons["So you're saying Fer"]).toMatch(/line by Sam Host, the host/);
    expect(reasons['we will ship twenty ']).toMatch(/number mismatch/);
  });

  test('fills ids, dates, source position and person from code, not the model', () => {
    const tenK = result.claims[0]!;
    expect(tenK).toMatchObject({
      id: claimId('dana-founder', '2025-01-15', TEN_K_SHARPER.claim),
      person: 'Dana Founder',
      personSlug: 'dana-founder',
      quote: TEN_K.quote,
      saidDate: '2025-01-15',
      targetDate: '2025-12-31',
      targetDateInferred: false,
      specificity: 5,
      source: { ...SOURCE, timestampSec: 168 },
    });
    expect(Date.parse(tenK.extractedAt!)).not.toBeNaN();
  });

  test('stores the transcript words when the model quote is not character-exact', () => {
    const monterrey = result.claims[1]!;
    // The transcript's own words and closing period, never the model's copy.
    expect(monterrey.quote).toBe('Our second factory, in Monterrey, will probably open by the middle of 2026.');
    expect(monterrey.topic).toBe('ferrowind-monterrey-factory');
    expect(monterrey.hedge).toBe('probably');
  });

  test('probability comes from hedge.ts; a hedge the speaker never used near the quote is discarded', () => {
    const p = Object.fromEntries(result.claims.map((c) => [c.topic, [c.hedge, c.impliedProbability]]));
    expect(p['ferrowind-f2-shipments']).toEqual(['for sure', 0.95]);
    expect(p['ferrowind-monterrey-factory']).toEqual(['probably', 0.7]);
    // "coin flip" is Dana's follow-up two lines later: kept.
    expect(p['home-robot-price']).toEqual(['coin flip', 0.5]);
    // "definitely" appears nowhere near "We might go public": dropped, and the claim text is not consulted.
    expect(p['ferrowind-ipo']).toEqual(['', 0.85]);
    // "should" in the model's claim sentence is not the speaker's hedge.
    expect(p['robot-tax']).toEqual(['', 0.85]);
  });

  test('deadlines only on predictions, and only real calendar dates', () => {
    const stance = result.claims.find((c) => c.topic === 'robot-tax')!;
    expect(stance.targetDate).toBeUndefined();
    expect(stance.targetDateInferred).toBeUndefined();
    const f3 = result.claims.find((c) => c.topic === 'ferrowind-f3-launch')!;
    expect(f3.targetDate).toBeUndefined();
  });

  test('sends one extract_claims request per chunk with the full prompt', () => {
    expect(llm.calls).toHaveLength(2);
    for (const req of llm.calls) {
      expect(req).toMatchObject({ schemaName: 'extract_claims', system: EXTRACT_SYSTEM, role: 'extractor' });
      expect(req.webSearch).toBeUndefined();
      expect(req.user).toContain('Speaker: Dana Founder');
      expect(req.user).toContain('Host (never attribute their words to the speaker): Sam Host');
      expect(req.user).toContain('Date said: 2025-01-15');
      expect(req.user).toContain('Existing topic keys for Dana Founder: none yet');
    }
    expect(llm.calls[0]!.user).toContain('Dana Founder: We build general-purpose humanoid robots.');
  });

  test('streams progress: chunks, candidates, each verified claim once, drops, then done', () => {
    const stages = events.map((e) => e.stage);
    expect(stages.filter((s) => s === 'chunk')).toHaveLength(2);
    expect(stages.filter((s) => s === 'candidates')).toHaveLength(2);
    expect(stages.filter((s) => s === 'dropped')).toHaveLength(3);
    expect(events.filter((e) => e.stage === 'verified').every((e) => e.claim)).toBe(true);
    // 7 claims, plus the sharper duplicate that replaces the first one's card.
    expect(stages.filter((s) => s === 'verified')).toHaveLength(8);
    const replacement = events.find((e) => e.replacedId);
    expect(replacement).toMatchObject({ stage: 'verified', replacedId: claimId('dana-founder', '2025-01-15', TEN_K.claim) });
    expect(replacement?.claim?.claim).toBe(TEN_K_SHARPER.claim);
    expect(events.at(-1)).toMatchObject({ stage: 'done', count: 7 });
  });
});

describe('extractClaims options and errors', () => {
  test('rejects a source without a real date', async () => {
    const llm = interviewModel();
    await expect(extractClaims(interview, llm, { ...OPTS, source: { ...SOURCE, date: '2025-13-01' } })).rejects.toThrow(/source.date/);
    expect(llm.calls).toHaveLength(0);
  });

  test('maxChunks limits the model calls', async () => {
    const llm = interviewModel();
    await extractClaims(interview, llm, { ...OPTS, maxChunks: 1 });
    expect(llm.calls).toHaveLength(1);
  });

  test('a failing chunk fails the extraction', async () => {
    const llm = new MockLLM(() => {
      throw new Error('model down');
    });
    await expect(extractClaims(interview, llm, OPTS)).rejects.toThrow('model down');
  });

  test('speakerSlug overrides the slug and YouTube sources get deep links', async () => {
    const yt: SourceRef = { ...SOURCE, url: 'https://www.youtube.com/watch?v=SYNTH000001' };
    const { claims } = await extractClaims(interview, new MockLLM(() => ({ claims: [TEN_K] })), {
      ...OPTS,
      source: yt,
      speakerSlug: 'dana',
      maxChunks: 1,
    });
    expect(claims[0]!.personSlug).toBe('dana');
    expect(claims[0]!.source.deepLink).toBe('https://www.youtube.com/watch?v=SYNTH000001&t=168s');
  });
});

describe('concurrency', () => {
  // ~64k chars of one speaker: six chunks, each with its own "ship N robots" line.
  const segments: Segment[] = Array.from({ length: 64 }, (_, i) => ({
    speaker: 'Dana Founder',
    text: `We will ship ${i + 1} robots next year. ${'And that is the plan we keep. '.repeat(30)}`,
  }));
  const long: Transcript = { text: buildText(segments).text, segments, meta: {} };

  test('runs at most three chunks at once and still returns claims in transcript order', async () => {
    let inFlight = 0;
    let peak = 0;
    const llm = new MockLLM(async (req) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(Math.floor(Math.random() * 15));
      inFlight--;
      const n = /We will ship (\d+) robots next year/.exec(req.user)![1];
      return { claims: [candidate({ quote: `We will ship ${n} robots next year.`, claim: `Acme will ship ${n} robots by the end of 2025.`, targetDate: '2025-12-31' })] };
    });
    const { claims } = await extractClaims(long, llm, OPTS);
    expect(llm.calls.length).toBeGreaterThan(EXTRACT_CONCURRENCY);
    expect(peak).toBe(EXTRACT_CONCURRENCY);
    const numbers = claims.map((c) => Number(/ship (\d+)/.exec(c.claim)![1]));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers).toHaveLength(llm.calls.length);
  });

  test('mapLimit keeps input order and the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(x);
      inFlight--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});

describe('prompt', () => {
  const chunk = { index: 1, text: 'Dana Founder: We will ship.', startChar: 100, endChar: 127 };

  test('lists existing topic keys sorted and deduped, and wraps the excerpt', () => {
    const user = extractUserPrompt(chunk, { ...OPTS, existingTopics: ['robot-tax', 'ferrowind-ipo', 'robot-tax', ' '] });
    expect(user).toContain('Existing topic keys for Dana Founder: ferrowind-ipo, robot-tax');
    expect(user).toContain('Transcript excerpt, part 2 (characters 100-127):\n<transcript>\nDana Founder: We will ship.\n</transcript>');
  });

  test('is identical for an empty and a missing topic list (stable fixture keys)', () => {
    expect(extractUserPrompt(chunk, { ...OPTS, existingTopics: [] })).toBe(extractUserPrompt(chunk, OPTS));
  });

  test('without a host, warns that other voices are someone else', () => {
    expect(extractUserPrompt(chunk, { speaker: 'Dana Founder', source: SOURCE })).toContain(
      'Host: not named; any voice other than Dana Founder is someone else',
    );
  });

  test('system prompt covers the extraction rules', () => {
    for (const rule of ['Never extract the host', 'Falsifiability test', 'Atomic', 'character for character', '"next year" -> 2020-12-31', 'reuse it exactly', 'hedge']) {
      expect(EXTRACT_SYSTEM).toContain(rule);
    }
  });

  test('output schema is valid for OpenAI strict mode', () => {
    const schema = toOpenAISchema(zExtractClaims) as { properties: { claims: { items: { required: string[] } } } };
    expect(schema.properties.claims.items.required).toContain('targetDate');
  });

  test('topicsForSpeaker lists the speaker\'s topics, excluding the episode being re-ingested', () => {
    const l = ledgerOf([
      makeClaim({ personSlug: 'dana-founder', topic: 'robot-tax', claim: 'a' }),
      makeClaim({ personSlug: 'dana-founder', topic: 'ferrowind-ipo', claim: 'b', source: { ...SOURCE, url: 'https://example.com/other' } }),
      makeClaim({ personSlug: 'dana-founder', topic: 'robot-tax', claim: 'c' }),
      makeClaim({ personSlug: 'someone-else', topic: 'mars', claim: 'd' }),
    ]);
    expect(topicsForSpeaker(l, 'dana-founder')).toEqual(['ferrowind-ipo', 'robot-tax']);
    expect(topicsForSpeaker(l, 'dana-founder', 'https://example.com/ep')).toEqual(['ferrowind-ipo']);
  });
});

describe('dedupe', () => {
  const base = makeClaim({ claim: 'Acme will ship 10,000 robots by the end of 2025.', targetDate: '2025-12-31', specificity: 3 });
  const reworded = makeClaim({ claim: 'Acme will ship 10,000 humanoid robots by the end of 2025.', targetDate: '2025-12-31', specificity: 4 });

  test('near-identical wording is a duplicate; changed numbers, negations or deadlines are not', () => {
    expect(isNearDuplicate(base, reworded)).toBe(true);
    expect(isNearDuplicate(base, makeClaim({ claim: 'Acme will ship 20,000 robots by the end of 2025.', targetDate: '2025-12-31' }))).toBe(false);
    expect(isNearDuplicate(base, makeClaim({ claim: 'Acme will not ship 10,000 robots by the end of 2025.', targetDate: '2025-12-31' }))).toBe(false);
    expect(isNearDuplicate(base, makeClaim({ claim: 'Acme will ship 10,000 robots by the end of 2025.', targetDate: '2026-12-31' }))).toBe(false);
    expect(isNearDuplicate(base, makeClaim({ claim: base.claim, targetDate: '2025-12-31', type: 'stance' }))).toBe(false);
  });

  test('keeps the more specific duplicate in the first one\'s place', () => {
    const other = makeClaim({ claim: 'Something else entirely.', targetDate: undefined });
    expect(dedupeClaims([base, other, reworded]).map((c) => c.claim)).toEqual([reworded.claim, other.claim]);
    expect(dedupeClaims([reworded, base])).toEqual([reworded]);
    expect(dedupeClaims([base, { ...base }])).toEqual([base]);
  });
});

test('isCalendarDate', () => {
  expect(isCalendarDate('2024-02-29')).toBe(true);
  expect(isCalendarDate('2025-02-29')).toBe(false);
  expect(isCalendarDate('2025-12')).toBe(false);
  expect(isCalendarDate(null)).toBe(false);
});

// Guards the mock itself: requests carry the zod schema MockLLM validates against.
test('mock replies are validated against the extract schema', async () => {
  const llm = new MockLLM(() => ({ claims: [{ quote: 'x' }] }));
  await expect(extractClaims(interview, llm, { ...OPTS, maxChunks: 1 })).rejects.toThrow();
  expect((llm.calls[0] as JsonRequest<unknown>).schema).toBe(zExtractClaims);
});

describe('grounding: the claim may not say more than its quote', () => {
  const dates = { speaker: 'Dana Founder', saidDate: '2025-01-15', targetDate: '2026-12-31' };

  test('a one-word answer cannot carry a claim', () => {
    expect(groundingProblem('Absolutely.', 'Acme will ship one million robots by the end of 2026.', dates)).toMatch(/too short/);
  });

  test('numbers the quote lacks are rejected; the deadline written out is not', () => {
    const quote = 'We will launch the robot in Europe next year.';
    expect(groundingProblem(quote, 'Acme will sell 1,000,000 robots in Europe and reach $5 billion in revenue by the end of 2026.', dates)).toMatch(
      /numbers the quote does not: 1000000, 5000000000/,
    );
    expect(groundingProblem(quote, 'Acme will launch its robot in Europe by December 31, 2026.', dates)).toBeNull();
    expect(groundingProblem(quote, 'Acme will launch its robot in Europe by 2026-12-31.', dates)).toBeNull();
  });

  test('groundingProblem: a product code written H-20, H 20 or H20 is the same number on both sides', () => {
    const said = { speaker: 'Jensen Huang', saidDate: '2025-05-28' };
    const quote = "H-20 is as far down as we could take a Hopper, and the H 200 is still export controlled.";
    expect(groundingProblem(quote, 'Nvidia cannot cut the H20 down any further for China.', said)).toBeNull();
    expect(groundingProblem(quote, 'The H200 remains export controlled.', said)).toBeNull();
    expect(groundingProblem('We shipped the H20 as far down as we could take a Hopper.', 'The H-20 was cut down as far as a Hopper could go.', said)).toBeNull();
    expect(groundingProblem(quote, 'The H100 is as far down as Nvidia could take a Hopper.', said)).toMatch(/numbers the quote does not: h100/);
    expect(joinProductCodes(['in', '5', 'years', 'h', '20', 'top', '10'])).toEqual(['in', '5', 'years', 'h20', 'top', '10']);
    expect(groundingProblem('I think we will be cash-flow positive by Q2 next year.', 'Acme will be cash-flow positive by the end of the second quarter of 2026.', dates)).toBeNull();
    expect(groundingProblem('We will reach about half the US population next year.', 'Acme will serve 50% of the US population by 2026.', dates)).toBeNull();
  });

  test('a claim with no content word from the quote is rejected', () => {
    expect(groundingProblem('We are very excited about what comes next.', 'Acme will open a factory in Ohio.', dates)).toMatch(/no content words/);
  });

  function run(segments: Segment[], candidates: ExtractedClaim[]) {
    const t: Transcript = { text: buildText(segments).text, segments, meta: {} };
    return extractClaims(t, new MockLLM(() => ({ claims: candidates })), { speaker: 'Dana Founder', host: 'Sam Host', source: SOURCE });
  }

  test('a yes to the host\'s question is dropped end to end', async () => {
    const r = await run(
      [
        { speaker: 'Sam Host', text: 'Will Acme ship one million robots next year?' },
        { speaker: 'Dana Founder', text: 'Absolutely.' },
      ],
      [candidate({ quote: 'Absolutely.', claim: 'Acme will ship one million robots by the end of 2026.', targetDate: '2026-12-31', hedge: 'Absolutely' })],
    );
    expect(r.claims).toHaveLength(0);
    expect(r.dropped[0]!.reason).toMatch(/too short/);
  });

  test("the host's wording is never stored as the guest's quote", async () => {
    const r = await run(
      [
        { speaker: 'Sam Host', text: "So you'll definitely ship ten thousand robots to customers in Europe and the US by the end of next year?" },
        { speaker: 'Dana Founder', text: "Well, we'll probably ship ten thousand robots to customers in Europe and the US by the end of next year." },
      ],
      [
        candidate({
          quote: "you'll definitely ship ten thousand robots to customers in Europe and the US by the end of next year",
          claim: 'Acme will ship 10,000 robots to customers in Europe and the US by the end of 2026.',
          targetDate: '2026-12-31',
          hedge: 'definitely',
        }),
      ],
    );
    // The host's line matches exactly but is the host's; the guest's line is two edits away.
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]!.quote).toBe("we'll probably ship ten thousand robots to customers in Europe and the US by the end of next year.");
    expect(r.claims[0]!.hedge).toBe('');
  });
});

describe('hedgeNearQuote', () => {
  // YouTube-style captions: 5-8 words per unlabeled cue.
  const cues = [
    'and honestly I think',
    'we will ship ten thousand F2 robots',
    'to paying customers across the United',
    'States and Europe by the end',
    'of 2025 and that is for',
    'sure the plan we have committed',
    'to publicly with our board',
  ];
  const segments: Segment[] = cues.map((text, i) => ({ start: i * 3, text }));
  const t: Transcript = { text: buildText(segments).text, segments, meta: {} };
  const quote = 'we will ship ten thousand F2 robots to paying customers across the United States and Europe by the end of 2025 and that is for sure';

  test('a hedge inside a quote spanning many cues counts', async () => {
    const { checkQuote } = await import('../src/quote-check.ts');
    const m = checkQuote(quote, t);
    expect(m.verified).toBe(true);
    expect(hedgeNearQuote('for sure', t, m, 'Dana Founder')).toBe(true);
  });

  test('a hedge in the cue just before the quote counts', async () => {
    const { checkQuote } = await import('../src/quote-check.ts');
    const m = checkQuote(quote, t);
    expect(hedgeNearQuote('I think', t, m, 'Dana Founder')).toBe(true);
    expect(hedgeNearQuote('definitely', t, m, 'Dana Founder')).toBe(false);
  });

  test("a hedge in the host's line before the quote does not count", async () => {
    const { checkQuote } = await import('../src/quote-check.ts');
    const labeled: Segment[] = [
      { speaker: 'Sam Host', text: 'I think you will ship a lot of robots.' },
      { speaker: 'Dana Founder', text: 'We will ship ten thousand robots next year.' },
    ];
    const lt: Transcript = { text: buildText(labeled).text, segments: labeled, meta: {} };
    const m = checkQuote('We will ship ten thousand robots next year.', lt, { speaker: 'Dana Founder' });
    expect(hedgeNearQuote('I think', lt, m, 'Dana Founder')).toBe(false);
  });
});
