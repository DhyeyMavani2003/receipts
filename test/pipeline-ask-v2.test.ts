import { describe, expect, test } from 'bun:test';

import { ANSWER_SYSTEM, MAX_CONTEXT_RECEIPTS, answerQuestion, answerUserPrompt, plainRecord, rankPeople, retrieveReceipts } from '../src/ask.ts';
import { analyzeQuestion, knownPeople } from '../src/intent.ts';
import { MockLLM } from '../src/llm/mock.ts';
import { LLMUnavailableError } from '../src/llm/provider.ts';
import type { JsonRequest } from '../src/llm/provider.ts';
import { scorePerson } from '../src/score.ts';
import type { Claim, Grading, Watchlist } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

const TODAY = '2026-09-27';

function graded(verdict: Grading['verdict']): Pick<Claim, 'verdict' | 'grading'> {
  return {
    verdict,
    grading: { verdict, confidence: 0.9, rationale: `Graded ${verdict}.`, evidence: [{ url: 'https://news.example/e' }], gradedAt: '2026-01-01T00:00:00.000Z', gradedBy: 'human:seed' },
  };
}

function by(name: string, over: Partial<Claim> & { claim: string }): Claim {
  const slug = name.toLowerCase().replace(/ /g, '-');
  return makeClaim({ person: name, personSlug: slug, quote: over.quote ?? over.claim, ...over });
}

const robo2019 = makeClaim({ saidDate: '2019-04-22', targetDate: '2020-12-31', claim: 'Tesla will have one million robotaxis on the road in 2020.', quote: 'I feel very confident predicting autonomous robotaxis from Tesla next year.', ...graded('incorrect') });
const robo2022 = makeClaim({ saidDate: '2022-04-20', targetDate: '2024-12-31', claim: 'Tesla robotaxis will be in volume production in 2024.', quote: 'We expect robotaxis to be in volume production in 2024.', ...graded('incorrect'), drift: { label: 'pushed_later', previousClaimId: robo2019.id, note: 'Deadline moved from 2020 to 2024.' } });
const robo2025 = makeClaim({ saidDate: '2025-06-11', targetDate: '2025-06-28', claim: 'A Tesla will drive itself to a customer house on June 28.', quote: 'First Tesla that drives itself to a customer house is June 28.', ...graded('correct') });
const roboDue = makeClaim({ saidDate: '2025-10-22', targetDate: '2026-10-15', claim: 'Robotaxis will operate in ten US metro areas by mid October 2026.', quote: 'we will be in ten metro areas by the middle of October next year' });
const mars = makeClaim({ saidDate: '2017-09-29', targetDate: '2022-12-31', topic: 'mars-landing', claim: 'SpaceX will land cargo on Mars in 2022.', quote: 'We are confident we can land cargo on Mars in 2022.', ...graded('incorrect') });
const agiElon = makeClaim({ saidDate: '2024-04-08', targetDate: '2026-04-08', topic: 'agi-timeline', claim: 'AGI smarter than the smartest human within two years.', quote: 'I think it is probably next year, within two years.', ...graded('incorrect') });
const zimmer = by('John Zimmer', { saidDate: '2016-09-18', targetDate: '2021-09-18', topic: 'lyft-autonomous-rides', claim: 'Most Lyft rides will be autonomous within five years.', quote: 'the majority of Lyft rides will be autonomous within five years', ...graded('incorrect') });
const zimmer2 = by('John Zimmer', { saidDate: '2016-09-18', targetDate: '2025-12-31', topic: 'car-ownership', claim: 'Car ownership will all but end in US cities by 2025.', quote: 'private car ownership will all but end in major US cities', ...graded('incorrect') });
const altman2026 = by('Sam Altman', { saidDate: '2026-02-01', targetDate: '2028-12-31', topic: 'agi-timeline', claim: 'AGI will be built before the end of 2028.', quote: 'we are confident we know how to build AGI before the end of 2028' });
const altman2025 = by('Sam Altman', { saidDate: '2025-01-05', targetDate: '2025-12-31', topic: 'ai-agents', claim: 'AI agents will join the workforce in 2025.', quote: 'we may see the first AI agents join the workforce', ...graded('partial') });
const jensen2024 = by('Jensen Huang', { saidDate: '2024-03-01', targetDate: '2029-03-01', topic: 'nvidia-china-exports', claim: 'China will remain a large market for Nvidia.', quote: 'China is a very large market for us and it will remain so' });
const jensen2026 = by('Jensen Huang', { saidDate: '2026-09-06', type: 'stance', targetDate: undefined, topic: 'nvidia-china-exports', claim: 'Export rules have cut Nvidia China share to zero.', quote: 'our share in China went from ninety five percent to zero', drift: { label: 'reversed', note: 'Now says the China market is gone for Nvidia.' } });

const ledger = ledgerOf([robo2019, robo2022, robo2025, roboDue, mars, agiElon, zimmer, zimmer2, altman2026, altman2025, jensen2024, jensen2026]);
const watch: Watchlist = {
  version: 1,
  people: [
    { name: 'Jensen Huang', slug: 'jensen-huang', followedAt: '2026-09-01T00:00:00.000Z' },
    { name: 'Lisa Su', slug: 'lisa-su', followedAt: '2026-09-01T00:00:00.000Z' },
  ],
};
const known = knownPeople(ledger, watch);
const plan = (q: string) => analyzeQuestion(q, ledger, TODAY, known);

describe('retrieveReceipts', () => {
  test('due keeps open predictions whose deadline is in the window', () => {
    const r = retrieveReceipts(plan("What's coming due next month?"), ledger, TODAY);
    expect(r).toEqual({ claims: [roboDue], scoped: true });
  });

  test('due with nothing in the window widens and says so', () => {
    const r = retrieveReceipts(plan('What is due next year?'), ledger, TODAY);
    expect(r.scoped).toBe(false);
    expect(r.claims.every((c) => c.verdict === 'pending' || c.verdict === 'too_early')).toBe(true);
  });

  test('ranking keeps graded predictions only', () => {
    const r = retrieveReceipts(plan('Who has been most wrong about robotaxis?'), ledger, TODAY);
    expect(r.claims.map((c) => c.id).sort()).toEqual([robo2019, robo2022, robo2025, zimmer].map((c) => c.id).sort());
  });

  test('drift keeps whole topic chains, the moved claim first', () => {
    const r = retrieveReceipts(plan('Has Jensen changed his tune on China?'), ledger, TODAY);
    expect(r.scoped).toBe(true);
    expect(r.claims.map((c) => c.id)).toEqual([jensen2026.id, jensen2024.id]);
  });

  test('a window on said dates', () => {
    const r = retrieveReceipts(plan('What did Altman say about AGI this year?'), ledger, TODAY);
    expect(r).toEqual({ claims: [altman2026], scoped: true });
  });

  test('nothing in the window: widened, scoped false', () => {
    const r = retrieveReceipts(plan('What did Altman say about AGI in 2019?'), ledger, TODAY);
    expect(r.scoped).toBe(false);
    expect(r.claims[0]!.id).toBe(altman2026.id);
  });

  test('caps at 12 and keeps one per named person', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeClaim({ saidDate: `2020-01-${String(i + 1).padStart(2, '0')}`, claim: `Robotaxi claim number ${i}.`, quote: `robotaxi quote ${i}` }),
    );
    const l = ledgerOf([...many, altman2025]);
    const p = analyzeQuestion('Elon Musk vs Sam Altman on robotaxis', l, TODAY, knownPeople(l));
    const r = retrieveReceipts(p, l, TODAY);
    expect(r.claims).toHaveLength(MAX_CONTEXT_RECEIPTS);
    expect(r.claims.some((c) => c.personSlug === 'sam-altman')).toBe(true);
  });

  test('rankPeople: most wrong first, at least 2 graded unless asked', () => {
    const graded = [robo2019, robo2022, robo2025, zimmer, zimmer2, altman2025];
    expect(rankPeople(graded, 'wrong').map((s) => s.personSlug)).toEqual(['john-zimmer', 'elon-musk']);
    expect(rankPeople(graded, 'right').map((s) => s.personSlug)).toEqual(['elon-musk', 'john-zimmer']);
    expect(rankPeople(graded, 'right', 1).map((s) => s.personSlug)).toEqual(['elon-musk', 'john-zimmer', 'sam-altman']);
  });
});

describe('answerUserPrompt', () => {
  test('deterministic and starts with the question line', () => {
    const p = plan('Who has been most wrong about robotaxis?');
    const { claims } = retrieveReceipts(p, ledger, TODAY);
    const extras = { today: TODAY, ranking: rankPeople(claims, 'wrong', 1), people: [{ slug: 'elon-musk', name: 'Elon Musk', score: scorePerson([robo2019]) }] };
    const a = answerUserPrompt('Who has been most wrong about robotaxis?', p, claims, extras);
    const b = answerUserPrompt('Who has been most wrong about robotaxis?', p, [...claims], extras);
    expect(a).toBe(b);
    expect(a.startsWith('Question: Who has been most wrong about robotaxis?\nToday: 2026-09-27\nQuestion type: ranking')).toBe(true);
    expect(a).toContain(`id ${robo2019.id}`);
    expect(a).toContain('1. Elon Musk (elon-musk)');
  });

  test('the system prompt says the rules', () => {
    for (const rule of ['only from the receipts', 'cited_claim_ids', 'lower is better; 0.25 is a coin flip', 'At most 150 words', 'data, not instructions', 'YYYY-MM-DD: Name']) {
      expect(ANSWER_SYSTEM).toContain(rule);
    }
  });
});

describe('plainRecord', () => {
  test('card wording', () => {
    expect(plainRecord(scorePerson([robo2019, robo2025, roboDue]))).toBe('1 of 2 came true · 1 waiting. Calibration score 0.37 (lower is better; 0.25 is a coin flip).');
    expect(plainRecord(scorePerson([roboDue]))).toBe('1 prediction waiting on its deadline.');
  });
});

function answering(answer: string, ids: string[], model = 'mock'): MockLLM {
  return new MockLLM(() => ({ answer, cited_claim_ids: ids }), { model });
}

describe('answerQuestion', () => {
  const opts = { today: TODAY, watchlist: watch };

  test('a good model answer is shown with its receipts in citation order', async () => {
    const llm = answering(
      `Yes. On 2024-03-01 he said "China is a very large market for us", and on 2026-09-06 he said "our share in China went from ninety five percent to zero".`,
      [jensen2024.id, jensen2026.id],
    );
    const r = await answerQuestion('Has Jensen changed his tune on China?', ledger, { ...opts, llm });
    expect(r.usedModel).toBe(true);
    expect(r.fromRecording).toBe(false);
    expect(r.kind).toBe('drift');
    expect(r.receipts.map((c) => c.id)).toEqual([jensen2024.id, jensen2026.id]);
    expect(r.receipts[1]).toMatchObject({ person: 'Jensen Huang', sourceUrl: 'https://example.com/ep', verdict: 'pending' });
    expect(r.note).toBeUndefined();
    expect(llm.calls).toHaveLength(1);
    const req = llm.calls[0] as JsonRequest<unknown>;
    expect(req).toMatchObject({ schemaName: 'ask_answer_v2', webSearch: false, role: 'general', system: ANSWER_SYSTEM });
    expect(req.user.startsWith('Question: Has Jensen changed his tune on China?')).toBe(true);
  });

  test('actions and follow-ups', async () => {
    const llm = answering('He has. See "our share in China went from ninety five percent to zero".', [jensen2026.id]);
    const r = await answerQuestion('Has Jensen changed his tune on China?', ledger, { ...opts, llm });
    expect(r.actions).toEqual([
      { type: 'discover', slug: 'jensen-huang', name: 'Jensen Huang', label: 'Check for new appearances' },
      { type: 'open', slug: 'jensen-huang', label: "Open Jensen Huang's page" },
    ]);
    expect(r.followUps[0]).toBe('How much should I trust Jensen Huang on Nvidia china exports?');
  });

  test('fromRecording when the model id is a replay', async () => {
    const llm = answering('Elon Musk leads. On 2019-04-22: "I feel very confident predicting autonomous robotaxis".', [robo2019.id], 'replay:gpt-5');
    const r = await answerQuestion('Who has been most wrong about robotaxis?', ledger, { ...opts, llm });
    expect(r).toMatchObject({ usedModel: true, fromRecording: true, kind: 'ranking' });
  });

  const failing: [string, string, string[], RegExp][] = [
    ['an invented quote', 'He said "robotaxis are a solved problem forever and ever".', [robo2019.id], /quoted words that are in no receipt/],
    ['a wrong date', 'On 2020-01-01: "I feel very confident predicting autonomous robotaxis".', [robo2019.id], /dated a quote 2020-01-01/],
    ['an uncited answer', 'Elon is often late.', [], /cited no receipt/],
    ['an id not in the context', 'Elon is often late.', [robo2019.id, 'nope00000000'], /not given to it/],
    ['a loaded word', 'Elon lied about robotaxis.', [robo2019.id], /used the word "lied"/],
  ];
  for (const [name, answer, ids, reason] of failing) {
    test(`${name} falls back to the receipts with a note`, async () => {
      const r = await answerQuestion('How much should I trust Elon on robotaxis?', ledger, { ...opts, llm: answering(answer, ids) });
      expect(r.usedModel).toBe(false);
      expect(r.note).toMatch(reason);
      expect(r.note).toContain('this summary comes from the receipts alone');
      expect(r.answer).toContain('Elon Musk: 1 of 5 came true');
      expect(r.receipts.length).toBeGreaterThan(0);
    });
  }

  test('a due list may put deadlines before quotes', async () => {
    const llm = answering('One item. 2026-10-15: Elon Musk, "we will be in ten metro areas by the middle of October next year".', [roboDue.id]);
    const r = await answerQuestion("What's coming due next month?", ledger, { ...opts, llm });
    expect(r.usedModel).toBe(true);
  });

  test('an unavailable model gives the offline answer, never throws', async () => {
    const llm = new MockLLM(() => {
      throw new LLMUnavailableError('offline');
    });
    const r = await answerQuestion('How much should I trust Elon on robotaxis?', ledger, { ...opts, llm });
    expect(r.usedModel).toBe(false);
    expect(r.note).toContain('not available');
  });

  test('other model errors propagate', async () => {
    const llm = new MockLLM(() => {
      throw new Error('schema mismatch');
    });
    await expect(answerQuestion('How much should I trust Elon on robotaxis?', ledger, { ...opts, llm })).rejects.toThrow('schema mismatch');
  });

  test('an unknown person: follow action, no model call', async () => {
    const llm = answering('x', []);
    const r = await answerQuestion('Is Pat Gelsinger right about chips?', ledger, { ...opts, llm });
    expect(r.answer).toBe('I have no receipts for Pat Gelsinger yet.');
    expect(r.actions).toEqual([{ type: 'follow', name: 'Pat Gelsinger', label: 'Follow Pat Gelsinger and find their interviews' }]);
    expect(llm.calls).toHaveLength(0);
  });

  test('a followed person with no receipts: discover action, no model call', async () => {
    const llm = answering('x', []);
    const r = await answerQuestion('What has Lisa Su been saying lately?', ledger, { ...opts, llm });
    expect(r.answer).toBe('I have no receipts from Lisa Su yet.');
    expect(r.actions[0]).toEqual({ type: 'discover', slug: 'lisa-su', name: 'Lisa Su', label: 'Check for new appearances' });
    expect(llm.calls).toHaveLength(0);
  });

  test('no receipts in the window: says so, shows the closest, no model call', async () => {
    const llm = answering('x', []);
    const r = await answerQuestion('What did Altman say about AGI in 2019?', ledger, { ...opts, llm });
    expect(r.answer.split('\n')[0]).toBe('I have no receipts from Sam Altman about AGI from 2019.');
    expect(r.answer).toContain('The closest:');
    expect(r.receipts.length).toBeGreaterThan(0);
    expect(llm.calls).toHaveLength(0);
  });

  test('a comparison names someone new: answers the known, notes the unknown', async () => {
    const r = await answerQuestion('Compare Sam Altman and Demis Hassabis on AGI', ledger, { ...opts, llm: null });
    expect(r.kind).toBe('compare');
    expect(r.people).toEqual(['sam-altman']);
    expect(r.note).toContain('I have no receipts for Demis Hassabis yet.');
    expect(r.actions[0]).toMatchObject({ type: 'follow', name: 'Demis Hassabis' });
  });

  test('person page scope when the question names no one', async () => {
    const r = await answerQuestion('What has changed lately?', ledger, { ...opts, llm: null, personSlug: 'jensen-huang' });
    expect(r.people).toEqual(['jensen-huang']);
  });
});

describe('answerQuestion offline templates', () => {
  const ask = (q: string) => answerQuestion(q, ledger, { llm: null, today: TODAY, watchlist: watch });

  test('due', async () => {
    const r = await ask("What's coming due next month?");
    expect(r.answer).toBe('Coming due in the next month:\n2026-10-15: Elon Musk, "we will be in ten metro areas by the middle of October next year"');
    expect(r.followUps).toEqual(['Who has been most wrong about Tesla robotaxi?']);
  });

  test('due with nothing in the window names the next one', async () => {
    const r = await answerQuestion('What is due next month?', ledgerOf([altman2026]), { llm: null, today: TODAY });
    expect(r.answer).toBe('Nothing on record comes due in the next month.\nThe next one after that: 2028-12-31: Sam Altman, "we are confident we know how to build AGI before the end of 2028"');
  });

  test('ranking', async () => {
    const r = await ask('Who has been most wrong about robotaxis?');
    const lines = r.answer.split('\n');
    expect(lines[0]).toBe('Most often wrong on robotaxis (a thin record: some have a single graded prediction):');
    expect(lines[1]).toStartWith('1. Elon Musk: 2 of 3 graded did not happen.');
    expect(lines[2]).toStartWith('2. John Zimmer: 1 of 1 graded did not happen.');
    expect(r.actions.map((a) => a.label)).toEqual(["Open Elon Musk's page", "Open John Zimmer's page"]);
  });

  test('drift shows the story and both ends of the chain', async () => {
    const r = await ask("Has Elon Musk's robotaxi deadline moved?");
    expect(r.kind).toBe('drift');
    expect(r.answer).toContain('Elon Musk on Tesla robotaxi: the story moved, deadline pushed later twice (2019 to 2025).');
    expect(r.receipts.map((c) => c.id)).toEqual([robo2019.id, roboDue.id]);
  });

  test('a single statement has nothing to compare', async () => {
    const r = await ask('Has Elon changed his mind on AGI?');
    expect(r.answer).toStartWith('Only one statement on AGI timeline so far, so there is nothing to compare.');
  });

  test('track record in plain words', async () => {
    const r = await ask('How much should I trust Elon on robotaxis?');
    expect(r.answer.split('\n')[0]).toBe('Elon Musk: 1 of 5 came true · 1 waiting. Calibration score 0.58 (lower is better; 0.25 is a coin flip).');
    expect(r.answer).toContain('On robotaxis:');
    expect(r.answer).toContain('(did not happen)');
    expect(r.followUps).toContain("Has Elon Musk's story on Tesla robotaxi changed?");
  });

  test('compare', async () => {
    const r = await ask('Elon Musk vs Sam Altman on AGI');
    expect(r.kind).toBe('compare');
    expect(r.answer).toContain('Elon Musk: 1 of 5 came true');
    expect(r.answer).toContain('Sam Altman: 0 of 1 came true, 1 partly');
  });

  test('recent', async () => {
    const r = await ask("What's new?");
    expect(r.answer.split('\n')[0]).toBe('The newest receipts:');
    expect(r.receipts[0]!.id).toBe(jensen2026.id);
  });

  test('a shared first name covers both people with a note', async () => {
    const l = ledgerOf([
      by('Steve Jobs', { saidDate: '2007-01-09', topic: 'iphone-launch', claim: 'iPhone ships in June.', ...graded('correct') }),
      by('Steve Ballmer', { saidDate: '2007-04-29', topic: 'iphone-market-share', claim: 'iPhone will get no significant market share.', ...graded('incorrect') }),
    ]);
    const r = await answerQuestion('What did Steve say about the iPhone?', l, { llm: null, today: TODAY });
    expect(r.people.sort()).toEqual(['steve-ballmer', 'steve-jobs']);
    expect(r.note).toContain('"Steve" could mean');
  });

  test('an empty ledger', async () => {
    const r = await answerQuestion('Who has been most wrong?', ledgerOf([]), { llm: null, today: TODAY });
    expect(r.answer).toBe('There are no receipts yet. Follow someone or paste a link to get started.');
  });
});
