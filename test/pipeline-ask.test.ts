import { describe, expect, test } from 'bun:test';

import {
  ASK_SYSTEM,
  answerProblem,
  ask,
  findPeople,
  matchPeople,
  questionKeywords,
  rankReceipts,
  scoreSummary,
  stem,
  storyLine,
  templateReceipts,
} from '../src/ask.ts';
import { MockLLM } from '../src/llm/mock.ts';
import { LLMUnavailableError } from '../src/llm/provider.ts';
import { scorePerson } from '../src/score.ts';
import type { Claim, Grading } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

function graded(verdict: Grading['verdict'], extra: Partial<Grading> = {}): Pick<Claim, 'verdict' | 'grading'> {
  return {
    verdict,
    grading: {
      verdict,
      confidence: 0.9,
      rationale: `Graded ${verdict}.`,
      evidence: [{ url: 'https://news.example/evidence' }],
      gradedAt: '2026-01-01T00:00:00.000Z',
      gradedBy: 'human:seed',
      ...extra,
    },
  };
}

const robotaxi2019 = makeClaim({
  saidDate: '2019-04-22',
  claim: 'Tesla will have over one million robotaxis on the road in 2020.',
  quote: 'I feel very confident predicting that there will be autonomous robotaxis from Tesla next year.',
  ...graded('incorrect'),
});
const robotaxi2020 = makeClaim({
  saidDate: '2020-07-09',
  targetDate: '2021-12-31',
  claim: 'Tesla robotaxis will operate without drivers by the end of 2021.',
  quote: 'I am extremely confident that robotaxis will be driverless next year.',
  ...graded('incorrect'),
});
const mars = makeClaim({
  saidDate: '2017-09-29',
  targetDate: '2022-12-31',
  topic: 'spacex-mars-landing',
  claim: 'SpaceX will land cargo on Mars in 2022.',
  quote: 'We are confident we can land cargo on Mars in 2022.',
  ...graded('incorrect'),
});
const starlink = makeClaim({
  saidDate: '2016-01-01',
  targetDate: '2020-12-31',
  topic: 'starlink-service',
  claim: 'Starlink will offer internet service by 2020.',
  quote: 'Starlink will be offering service by 2020.',
  ...graded('correct', { resolvedOn: '2020-10-27' }),
});
const altman = makeClaim({
  personSlug: 'sam-altman',
  person: 'Sam Altman',
  topic: 'openai-agi-timeline',
  claim: 'OpenAI will build AGI by 2025.',
  quote: 'We will build AGI by 2025.',
  targetDate: '2025-12-31',
});
const ledger = ledgerOf([robotaxi2019, robotaxi2020, mars, starlink, altman]);

describe('findPeople', () => {
  test.each([
    ['How much should I trust Elon Musk on robotaxis?', ['elon-musk']],
    ["Is Musk's robotaxi timeline credible?", ['elon-musk']],
    ['what about elon-musk', ['elon-musk']],
    ['Compare Sam Altman and Elon Musk on timelines', ['sam-altman', 'elon-musk']],
    ['Compare Sam Altman and Elon on timelines', ['sam-altman']],
    ['Should I trust Altman?', ['sam-altman']],
    ['what about musk on robotaxis', ['elon-musk']],
    ['Will it rain tomorrow?', []],
    ['Tell me about muskrats', []],
  ])('%p -> %p', (q, expected) => {
    expect(findPeople(q, ledger)).toEqual(expected);
  });

  test('a lone first name, or a last name after another first name, borrows no one\'s record', () => {
    const l = ledgerOf([
      altman,
      robotaxi2019,
      makeClaim({ personSlug: 'john-zimmer', person: 'John Zimmer', claim: 'z' }),
      makeClaim({ personSlug: 'bill-gates', person: 'Bill Gates', claim: 'g' }),
      makeClaim({ personSlug: 'steve-jobs', person: 'Steve Jobs', claim: 'j' }),
      makeClaim({ personSlug: 'mark-zuckerberg', person: 'Mark Zuckerberg', claim: 'm' }),
    ]);
    expect(matchPeople('How much should I trust John Carmack on AGI timelines?', l)).toEqual({
      people: [],
      suggestions: [{ asked: 'John Carmack', people: [{ slug: 'john-zimmer', name: 'John Zimmer' }] }],
    });
    expect(matchPeople('Is Kimbal Musk right about food?', l).people).toEqual([]);
    expect(matchPeople('Is Kimbal Musk right about food?', l).suggestions[0]!.asked).toBe('Kimbal Musk');
    expect(findPeople('Mark my words: is Sam Altman right about jobs?', l)).toEqual(['sam-altman']);
    expect(findPeople('How much should I trust Sam Altman on the AI bill in Congress?', l)).toEqual(['sam-altman']);
    expect(findPeople('Should I trust Gates on vaccines?', l)).toEqual([]);
    expect(matchPeople('Should I trust Gates on vaccines?', l).suggestions[0]!.people[0]!.slug).toBe('bill-gates');
    expect(findPeople('Should I trust Bill Gates on vaccines?', l)).toEqual(['bill-gates']);
  });

  test('a shared first name alone is ambiguous and matches nobody', () => {
    const l = ledgerOf([altman, makeClaim({ personSlug: 'sam-bankman-fried', person: 'Sam Bankman-Fried', claim: 'x' })]);
    expect(findPeople('Can I trust Sam?', l)).toEqual([]);
    expect(findPeople('Can I trust Sam Altman?', l)).toEqual(['sam-altman']);
  });
});

describe('ranking', () => {
  test('keywords skip stopwords and names, with light stemming', () => {
    expect(questionKeywords('How much should I trust Elon Musk on robotaxis?', ['Elon Musk'])).toEqual(['robotaxi']);
  });

  test('stemming treats plural and singular alike on both sides', () => {
    for (const [a, b] of [['timelines', 'timeline'], ['prices', 'price'], ['deliveries', 'delivery'], ['shipping', 'ship'], ['robotaxis', 'robotaxi'], ['cars', 'car']]) {
      expect(stem(a!)).toBe(stem(b!));
    }
  });

  test('topic matches first, then graded, then newest', () => {
    const ranked = rankReceipts([mars, starlink, robotaxi2019, robotaxi2020], ['robotaxi']);
    expect(ranked.map((r) => r.claim.id)).toEqual([robotaxi2020.id, robotaxi2019.id, mars.id, starlink.id]);
    expect(ranked[0]!.score).toBe(1);
  });

  test('scoreSummary states counts, accuracy, Brier baseline and lateness', () => {
    const s = scoreSummary(scorePerson([robotaxi2019, robotaxi2020, mars, starlink]));
    expect(s).toContain('4 predictions on record: 1 correct, 3 incorrect');
    expect(s).toContain('Accuracy 25% (1 of 4).');
    expect(s).toContain('0.25 is a coin flip');
  });
});

describe('ask without a model', () => {
  test('templated answer from scores and the on-topic receipts only', async () => {
    const res = await ask('How much should I trust Elon Musk on robotaxis?', ledger, null);
    expect(res.usedModel).toBe(false);
    expect(res.people).toEqual(['elon-musk']);
    expect(res.receipts.map((c) => c.id)).toEqual([robotaxi2019.id, robotaxi2020.id]);
    expect(res.answer).toContain('Elon Musk: 4 predictions on record');
    expect(res.answer).toContain('Receipts on robotaxis:');
    expect(res.answer).toContain(`- 2020-07-09: "${robotaxi2020.quote}" (INCORRECT, due 2021-12-31)`);
    expect(res.answer).toContain('Only 4 graded predictions: a thin record.');
  });

  test('says so when no receipt is on the asked topic, or nothing is graded', async () => {
    const res = await ask('Should I trust Sam Altman on nuclear fusion?', ledger, null);
    expect(res.answer).toContain('No graded predictions yet');
    expect(res.answer).toContain('None of the receipts are about nuclear fusion');
    expect(res.receipts).toEqual([altman]);
  });

  test('with many receipts on topic, shows the oldest and newest, and the story drift', async () => {
    const chain = ['2016-01-10', '2019-04-22', '2020-07-09', '2022-06-01', '2025-01-15'].map((saidDate, i) =>
      makeClaim({ saidDate, targetDate: `${2017 + 2 * i}-12-31`, claim: `Robotaxis by ${2017 + 2 * i}.`, quote: `Robotaxis ${i}` }),
    );
    const res = await ask('How much should I trust Elon Musk on robotaxi timelines?', ledgerOf(chain), null);
    const dates = res.receipts.map((c) => c.saidDate);
    expect(dates[0]).toBe('2016-01-10');
    expect(dates.at(-1)).toBe('2025-01-15');
    expect(res.answer).toContain('Story on tesla-robotaxi: deadline pushed later 4 times (2016 to 2025).');
  });

  test('templateReceipts keeps the on-topic ones oldest first, and never tops them up with unrelated ones', () => {
    const ranked = rankReceipts([mars, starlink, robotaxi2019, robotaxi2020], ['robotaxi']);
    expect(templateReceipts(ranked).map((c) => c.id)).toEqual([robotaxi2019.id, robotaxi2020.id]);
  });

  test('templateReceipts keeps only the top relevance tier: a robotaxi question never cites a Tesla Semi receipt', () => {
    const semi = makeClaim({
      saidDate: '2017-11-16',
      targetDate: '2019-12-31',
      topic: 'tesla-semi',
      claim: 'Tesla Semi production begins in 2019.',
      quote: 'Tesla production begins 2019.',
      ...graded('incorrect'),
    });
    const keywords = questionKeywords('How much should I trust Elon Musk on Tesla robotaxi timelines?', ['Elon Musk']);
    const ranked = rankReceipts([semi, mars, robotaxi2019, robotaxi2020], keywords);
    const picked = templateReceipts(ranked).map((c) => c.id);
    expect(picked).toContain(robotaxi2019.id);
    expect(picked).toContain(robotaxi2020.id);
    expect(picked).not.toContain(semi.id);
  });

  test('storyLine is null when nothing moved', () => {
    expect(storyLine('tesla-robotaxi', [robotaxi2019], () => undefined)).toBeNull();
  });

  test('a partly matching name gets a "did you mean", not the other person\'s record', async () => {
    const res = await ask('How much should I trust Kimbal Musk on restaurants?', ledger, null);
    expect(res).toMatchObject({ people: [], receipts: [], usedModel: false });
    expect(res.answer).toBe('I have no receipts for Kimbal Musk; did you mean Elon Musk?');
  });

  test('no one named: lists who is on record and never calls the model', async () => {
    const llm = new MockLLM(() => ({ answer: 'x', cited_claim_ids: [] }));
    const res = await ask('Is the moon made of cheese?', ledger, llm);
    expect(llm.calls).toHaveLength(0);
    expect(res).toMatchObject({ people: [], receipts: [], usedModel: false });
    expect(res.answer).toContain('Elon Musk, Sam Altman');
  });
});

describe('ask with a model', () => {
  test('sends scores, receipts and the GBrain scorecard; keeps only cited receipts from the context', async () => {
    const llm = new MockLLM(() => ({
      answer: '  Treat his robotaxi timelines with caution.  ',
      cited_claim_ids: [robotaxi2019.id, 'made-up-id', robotaxi2019.id, robotaxi2020.id],
    }));
    const res = await ask('How much should I trust Musk on robotaxis?', ledger, llm, {
      gbrainScorecards: { 'people/elon-musk': { accuracy: 0.25, brier: 0.4 } },
    });
    expect(res).toMatchObject({ answer: 'Treat his robotaxi timelines with caution.', people: ['elon-musk'], usedModel: true });
    expect(res.receipts.map((c) => c.id)).toEqual([robotaxi2019.id, robotaxi2020.id]);

    const req = llm.calls[0]!;
    expect(req).toMatchObject({ schemaName: 'ask_answer', system: ASK_SYSTEM, webSearch: true });
    expect(req.user).toStartWith('Question: How much should I trust Musk on robotaxis?');
    expect(req.user).toContain('## Elon Musk (elon-musk)');
    expect(req.user).toContain(`- id ${robotaxi2020.id} | said 2020-07-09`);
    expect(req.user).toContain(`quote: "${robotaxi2019.quote}"`);
    expect(req.user).toContain('GBrain scorecard: {"accuracy":0.25,"brier":0.4}');
    // The question's own topic gets its own numbers, and off-topic receipts stay out of the context.
    expect(req.user).toContain('On topic tesla-robotaxi: 2 predictions on record: 0 correct, 2 incorrect');
    expect(req.user).toContain('Lateness: not measured');
    expect(req.user).not.toContain(mars.id);
  });

  test('a stance or factual receipt is labeled as never graded, not pending', async () => {
    const stance = makeClaim({ type: 'stance', claim: 'Robotaxis are the future of Tesla.', quote: 'Robotaxis are the future.', saidDate: '2024-01-01', targetDate: undefined });
    const llm = new MockLLM(() => ({ answer: 'Thin record.', cited_claim_ids: [stance.id] }));
    await ask('How much should I trust Musk on robotaxis?', ledgerOf([stance, robotaxi2019]), llm);
    expect(llm.calls[0]!.user).toContain(`- id ${stance.id} | said 2024-01-01 in "Autonomy Day" | stance | topic tesla-robotaxi | NOT A PREDICTION (never graded)`);
  });

  test('no valid citation: the template answers, with a note saying why', async () => {
    const llm = new MockLLM(() => ({ answer: 'Thin record.', cited_claim_ids: ['deadbeef0000'] }));
    const res = await ask('Trust Altman?', ledger, llm);
    expect(res).toMatchObject({ usedModel: false, receipts: [altman] });
    expect(res.answer).toContain('Sam Altman: 1 prediction on record');
    expect(res.note).toContain('cited no receipt');
  });

  test('an invented quote, a wrong date or loaded words never reach the reader', async () => {
    const answers = [
      `On 2023-05-01 he said "I lied about FSD being ready". Be careful.`,
      `On 2018-01-01 he said "extremely confident that robotaxis will be driverless".`,
      'He misled everyone about robotaxis.',
    ];
    for (const answer of answers) {
      const llm = new MockLLM(() => ({ answer, cited_claim_ids: [robotaxi2020.id] }));
      const res = await ask('How much should I trust Musk on robotaxis?', ledger, llm);
      expect(res.usedModel).toBe(false);
      expect(res.answer).not.toContain(answer);
      expect(res.note).toContain('was not shown');
    }
  });

  test('answerProblem accepts exact, dated, shortened quotes and short labels', () => {
    const ok = `On 2020-07-09 he said "extremely confident that robotaxis … driverless next year", graded "incorrect".`;
    expect(answerProblem(ok, [robotaxi2019, robotaxi2020])).toBeNull();
    expect(answerProblem('“We will build AGI by 2025.”', [altman])).toBeNull();
    expect(answerProblem('2021-03-01: “We will build AGI by 2025.”', [altman])).toContain('not when it was said');
  });

  test('an unavailable model (no key, no replay fixture) falls back to the template', async () => {
    const llm = new MockLLM(() => {
      throw new LLMUnavailableError('No replay fixture');
    });
    const res = await ask('How much should I trust Elon Musk on robotaxis?', ledger, llm);
    expect(res.usedModel).toBe(false);
    expect(res.answer).toContain('Elon Musk: 4 predictions on record');
  });

  test('other model errors propagate', async () => {
    const llm = new MockLLM(() => {
      throw new Error('schema mismatch');
    });
    await expect(ask('Trust Musk?', ledger, llm)).rejects.toThrow('schema mismatch');
  });

  test('system prompt forbids invented claims and requires uncertainty and neutral tone', () => {
    for (const rule of ['Never invent claims', 'cited_claim_ids', 'State the uncertainty', 'Never call anyone a liar', 'At most 150 words']) {
      expect(ASK_SYSTEM).toContain(rule);
    }
  });
});
