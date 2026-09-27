import { describe, expect, test } from 'bun:test';

import {
  analyzeQuestion,
  didYouMean,
  isNameLike,
  knownPeople,
  resolvePeople,
  routeInput,
  routeInputSync,
  sharedNames,
  timeWindow,
} from '../src/intent.ts';
import { MockLLM } from '../src/llm/mock.ts';
import type { Claim, Watchlist } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

const TODAY = '2026-09-27';

function person(name: string, slug: string, topic: string, over: Partial<Claim> = {}): Claim {
  return makeClaim({ person: name, personSlug: slug, topic, claim: `${name} says something about ${topic} ${over.saidDate ?? ''}`, ...over });
}

const ledger = ledgerOf([
  makeClaim({ saidDate: '2019-04-22', claim: 'One million robotaxis in 2020.' }),
  makeClaim({ saidDate: '2024-04-08', topic: 'agi-timeline', claim: 'AGI next year.' }),
  person('Sam Altman', 'sam-altman', 'agi-timeline', { saidDate: '2026-02-01' }),
  person('Jensen Huang', 'jensen-huang', 'nvidia-china-exports', { saidDate: '2026-05-01' }),
  person('Steve Jobs', 'steve-jobs', 'iphone-launch', { saidDate: '2007-01-09' }),
  person('Steve Ballmer', 'steve-ballmer', 'iphone-market-share', { saidDate: '2007-04-29' }),
  person('Mark Zuckerberg', 'mark-zuckerberg', 'metaverse-adoption', { saidDate: '2021-10-28' }),
  person('Bill Gates', 'bill-gates', 'pandemic-risk', { saidDate: '2015-04-03' }),
  person('John Zimmer', 'john-zimmer', 'lyft-autonomous-rides', { saidDate: '2016-09-18' }),
]);

const watch: Watchlist = {
  version: 1,
  people: [
    { name: 'Jensen Huang', slug: 'jensen-huang', followedAt: '2026-09-01T00:00:00.000Z' },
    { name: 'Lisa Su', slug: 'lisa-su', followedAt: '2026-09-01T00:00:00.000Z', aliases: ['Dr. Su'] },
  ],
};

const known = knownPeople(ledger, watch);

describe('knownPeople', () => {
  test('ledger people plus followed people, with built-in aliases for known slugs', () => {
    const bySlug = new Map(known.map((p) => [p.slug, p]));
    expect(bySlug.get('lisa-su')).toMatchObject({ name: 'Lisa Su', followed: true });
    expect(bySlug.get('jensen-huang')?.followed).toBe(true);
    expect(bySlug.get('elon-musk')).toMatchObject({ followed: false, aliases: ['elon'] });
    expect(bySlug.get('mark-zuckerberg')?.aliases).toContain('zuck');
    expect(bySlug.get('sam-altman')?.aliases).toContain('sama');
  });
});

describe('resolvePeople', () => {
  const slugs = (t: string): string[] => resolvePeople(t, known).slugs;

  test('full names, slugs and possessives', () => {
    expect(slugs('How accurate is Elon Musk?')).toEqual(['elon-musk']);
    expect(slugs('what about elon-musk')).toEqual(['elon-musk']);
    expect(slugs("Jensen Huang's view on China")).toEqual(['jensen-huang']);
  });

  test('order of mention', () => {
    expect(slugs('Sam Altman vs Elon Musk on AGI')).toEqual(['sam-altman', 'elon-musk']);
  });

  test('a unique first name, capitalized', () => {
    expect(slugs('Has Jensen changed his tune on China?')).toEqual(['jensen-huang']);
    expect(slugs('What did Sam say?')).toEqual(['sam-altman']);
  });

  test('a shared first name is not sure', () => {
    expect(slugs('What did Steve say about the iPhone?')).toEqual([]);
    expect(sharedNames('What did Steve say about the iPhone?', known)).toEqual([{ asked: 'Steve', slugs: ['steve-ballmer', 'steve-jobs'] }]);
  });

  test('a distinctive last name', () => {
    expect(slugs('What did Altman say about AGI this year?')).toEqual(['sam-altman']);
    expect(slugs('Is Musk right?')).toEqual(['elon-musk']);
  });

  test('a last name after a different first name is someone else', () => {
    const r = resolvePeople('What did Kimbal Musk say?', known);
    expect(r.slugs).toEqual([]);
  });

  test('aliases: built-in and watchlist', () => {
    expect(slugs('Has Zuck changed his mind on the metaverse?')).toEqual(['mark-zuckerberg']);
    expect(slugs('sama on agi')).toEqual(['sam-altman']);
    expect(slugs('How much should I trust Elon on robotaxis?')).toEqual(['elon-musk']);
    expect(slugs('What has Dr. Su said?')).toEqual(['lisa-su']);
  });

  test('common-word names never match alone', () => {
    expect(slugs('Mark my words, jobs will change')).toEqual([]);
    expect(slugs('What did Bill Gates say about pandemics?')).toEqual(['bill-gates']);
  });

  test('fuzzy: one letter off a distinctive last name', () => {
    expect(slugs('What did Altmann say?')).toEqual(['sam-altman']);
    expect(slugs('Is Zuckerburg right?')).toEqual(['mark-zuckerberg']);
  });

  test('unknown names: runs of capitalized words that match no one', () => {
    const r = resolvePeople('Is Lisa Su more accurate than Pat Gelsinger on AI chips?', known);
    expect(r.slugs).toEqual(['lisa-su']);
    expect(r.unknownNames).toEqual(['Pat Gelsinger']);
    expect(resolvePeople('What does Demis Hassabis think about AGI?', known).unknownNames).toEqual(['Demis Hassabis']);
    expect(resolvePeople('Who has been most wrong about Tesla FSD?', known).unknownNames).toEqual([]);
    expect(resolvePeople('What is due in October?', known).unknownNames).toEqual([]);
  });

  test('spans point at the words in the text', () => {
    const text = 'Has Jensen Huang moved?';
    const r = resolvePeople(text, known);
    expect(r.spans.map((s) => text.slice(s.from, s.to))).toEqual(['Jensen Huang']);
  });

  test('didYouMean finds people sharing a name', () => {
    expect(didYouMean('Steve Wozniak', known).map((p) => p.slug).sort()).toEqual(['steve-ballmer', 'steve-jobs']);
    expect(didYouMean('Pat Gelsinger', known)).toEqual([]);
  });
});

describe('timeWindow', () => {
  test('this year, last year, in 2025, since 2020, before 2024', () => {
    expect(timeWindow('What did Altman say this year?', TODAY)).toEqual({ from: '2026-01-01', to: TODAY, field: 'saidDate', label: 'in 2026' });
    expect(timeWindow('last year', TODAY)).toMatchObject({ from: '2025-01-01', to: '2025-12-31', label: 'in 2025' });
    expect(timeWindow('What did he say in 2025?', TODAY)).toMatchObject({ from: '2025-01-01', to: '2025-12-31', field: 'saidDate' });
    expect(timeWindow('since 2020', TODAY)).toMatchObject({ from: '2020-01-01', to: TODAY, label: 'since 2020' });
    expect(timeWindow('before 2024', TODAY)).toEqual({ to: '2023-12-31', field: 'saidDate', label: 'before 2024' });
  });

  test('next month and coming due use deadlines', () => {
    expect(timeWindow("What's coming due next month?", TODAY)).toEqual({ from: '2026-09-28', to: '2026-10-28', field: 'targetDate', label: 'in the next month' });
    expect(timeWindow('due in the next 3 months', TODAY)).toMatchObject({ from: '2026-09-28', to: '2026-12-27', field: 'targetDate' });
    expect(timeWindow('What is due in 2027?', TODAY)).toMatchObject({ from: '2027-01-01', field: 'targetDate' });
  });

  test('lately, this month, last month, this week', () => {
    expect(timeWindow('What has Jensen been saying lately?', TODAY)).toEqual({ from: '2026-06-29', to: TODAY, field: 'saidDate', label: 'in the last 90 days' });
    expect(timeWindow('this month', TODAY)).toMatchObject({ from: '2026-09-01', to: TODAY });
    expect(timeWindow('last month', TODAY)).toMatchObject({ from: '2026-08-01', to: '2026-08-31', label: 'in August' });
    expect(timeWindow('this week', TODAY)).toMatchObject({ from: '2026-09-20', to: TODAY });
    expect(timeWindow('How accurate is Elon?', TODAY)).toBeUndefined();
  });
});

describe('analyzeQuestion', () => {
  const plan = (t: string) => analyzeQuestion(t, ledger, TODAY, known);

  test('each kind from the target questions', () => {
    expect(plan('Has Jensen changed his tune on China?').kind).toBe('drift');
    expect(plan('Who has been most wrong about robotaxis?').kind).toBe('ranking');
    expect(plan('What did Altman say about AGI this year?').kind).toBe('said_about');
    expect(plan("What's coming due next month?").kind).toBe('due');
    expect(plan('How much should I trust Elon on robotaxis?').kind).toBe('track_record');
    expect(plan('Sam Altman vs Elon Musk on AGI').kind).toBe('compare');
    expect(plan('Has Elon contradicted himself on AGI?').kind).toBe('contradiction');
    expect(plan("What's new with Jensen lately?").kind).toBe('recent');
    expect(plan('robotaxi timelines').kind).toBe('general');
  });

  test('a moved deadline is drift, not due', () => {
    expect(plan("Has Elon Musk's robotaxi deadline moved?").kind).toBe('drift');
    expect(plan('What deadlines are coming due?').kind).toBe('due');
  });

  test('ranking polarity', () => {
    expect(plan('Who has been most wrong about robotaxis?').polarity).toBe('wrong');
    expect(plan('Who has been most accurate?').polarity).toBe('right');
  });

  test('terms and topics, with synonyms', () => {
    const p = plan('How much should I trust Elon on robotaxis?');
    expect(p.people).toEqual(['elon-musk']);
    expect(p.terms).toEqual(['robotaxi']);
    expect(p.topics).toEqual(['lyft-autonomous-rides', 'tesla-robotaxi']);
    expect(plan('Has Jensen changed his tune on China?').topics).toEqual(['nvidia-china-exports']);
    expect(plan('What did Altman say about AGI this year?')).toMatchObject({ people: ['sam-altman'], terms: ['agi'], topics: ['agi-timeline'] });
  });

  test('name words and kind words are not topic terms', () => {
    expect(plan('Has Jensen changed his tune lately?').terms).toEqual([]);
    expect(plan('What did Steve say?').terms).toEqual([]);
  });

  test('unknown names are carried', () => {
    expect(plan('Is Pat Gelsinger right about chips?')).toMatchObject({ people: [], unknownNames: ['Pat Gelsinger'] });
  });
});

describe('routeInputSync', () => {
  const route = (t: string) => routeInputSync(t, known, ledger);

  test('URL, with and without a speaker', () => {
    expect(route('https://www.youtube.com/watch?v=abc123')).toEqual({ kind: 'pull', url: 'https://www.youtube.com/watch?v=abc123', text: 'https://www.youtube.com/watch?v=abc123', via: 'rule' });
    expect(route('pull https://youtu.be/abc123, as Jensen Huang')).toMatchObject({ kind: 'pull', url: 'https://youtu.be/abc123', speaker: 'Jensen Huang' });
    expect(route('https://example.com/talk. by lisa su')).toMatchObject({ kind: 'pull', url: 'https://example.com/talk', speaker: 'Lisa Su' });
    expect(route('receipts from https://example.com/x for the talk about stuff')).not.toHaveProperty('speaker');
  });

  test('local path', () => {
    expect(route('fixtures/transcripts/cnbc.txt')).toMatchObject({ kind: 'pull', url: 'fixtures/transcripts/cnbc.txt' });
    expect(route('~/Downloads/ep.mp3')).toMatchObject({ kind: 'pull' });
  });

  test('follow, unfollow, check', () => {
    expect(route('follow Lisa Su')).toMatchObject({ kind: 'follow', name: 'Lisa Su', slug: 'lisa-su' });
    expect(route('follow demis hassabis')).toMatchObject({ kind: 'follow', name: 'Demis Hassabis' });
    expect(route('track Elon')).toMatchObject({ kind: 'follow', name: 'Elon Musk', slug: 'elon-musk' });
    expect(route('unfollow Jensen Huang')).toMatchObject({ kind: 'unfollow', name: 'Jensen Huang', slug: 'jensen-huang' });
    expect(route('stop following Lisa Su')).toMatchObject({ kind: 'unfollow', slug: 'lisa-su' });
    expect(route('check Jensen Huang')).toMatchObject({ kind: 'discover', slug: 'jensen-huang' });
    expect(route('find new interviews for Lisa Su')).toMatchObject({ kind: 'discover', name: 'Lisa Su' });
    expect(route("what's new with Jensen")).toMatchObject({ kind: 'discover', slug: 'jensen-huang' });
  });

  test('"track record of ..." is not a follow', () => {
    expect(route('track record of elon on robotaxis')).toMatchObject({ kind: 'ask' });
  });

  test('a known name alone: person when followed, follow when not', () => {
    expect(route('Jensen Huang')).toMatchObject({ kind: 'person', name: 'Jensen Huang', slug: 'jensen-huang' });
    expect(route('Elon Musk')).toMatchObject({ kind: 'follow', name: 'Elon Musk', slug: 'elon-musk' });
    expect(route("jensen huang's")).toMatchObject({ kind: 'person' });
  });

  test('an unknown name follows, title-cased', () => {
    expect(route('Lisa Su')).toMatchObject({ kind: 'person' });
    expect(route('Demis Hassabis')).toEqual({ kind: 'follow', name: 'Demis Hassabis', text: 'Demis Hassabis', via: 'rule' });
    expect(route('Ursula von der Leyen')).toMatchObject({ kind: 'follow', name: 'Ursula von der Leyen' });
  });

  test('questions', () => {
    expect(route('How much should I trust Elon on robotaxis?')).toMatchObject({ kind: 'ask' });
    expect(route('robotaxi timelines')).toMatchObject({ kind: 'ask' });
    expect(route('Elon Musk?')).toMatchObject({ kind: 'ask' });
    expect(route('elon vs sam on agi')).toMatchObject({ kind: 'ask' });
  });

  test('topic-looking names are ambiguous', () => {
    expect(route('Nvidia China')).toEqual({ kind: 'ambiguous', text: 'Nvidia China' });
    expect(route('Anthropic')).toEqual({ kind: 'ambiguous', text: 'Anthropic' });
    expect(route('Musk')).toMatchObject({ kind: 'follow', slug: 'elon-musk' });
  });

  test('whitespace is collapsed', () => {
    expect(route('  follow    Lisa   Su  ')).toMatchObject({ kind: 'follow', text: 'follow Lisa Su' });
  });

  test('isNameLike', () => {
    expect(isNameLike('Lisa Su')).toBe(true);
    expect(isNameLike('lisa su')).toBe(false);
    expect(isNameLike('lisa su', { allowLower: true })).toBe(true);
    expect(isNameLike('The Big Short')).toBe(false);
    expect(isNameLike('Area 51')).toBe(false);
    expect(isNameLike('One Two Three Four Five')).toBe(false);
  });
});

describe('routeInput', () => {
  test('the router model is called only for an ambiguous input', async () => {
    const llm = new MockLLM(() => ({ intent: 'ask', name: null }));
    expect((await routeInput('How much should I trust Elon?', known, { llm, ledger })).kind).toBe('ask');
    expect((await routeInput('follow Lisa Su', known, { llm, ledger })).kind).toBe('follow');
    expect((await routeInput('Demis Hassabis', known, { llm, ledger })).kind).toBe('follow');
    expect(llm.calls).toHaveLength(0);
    expect(await routeInput('Nvidia China', known, { llm, ledger })).toEqual({ kind: 'ask', text: 'Nvidia China', via: 'model' });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).toMatchObject({ schemaName: 'route_input', webSearch: false, role: 'general', user: 'Input: Nvidia China' });
  });

  test('the model can say it is a person', async () => {
    const llm = new MockLLM(() => ({ intent: 'follow', name: 'Marques Brownlee' }));
    expect(await routeInput('Marques', known, { llm, ledger })).toEqual({ kind: 'follow', text: 'Marques', name: 'Marques Brownlee', via: 'model' });
    const known2 = new MockLLM(() => ({ intent: 'follow', name: 'jensen huang' }));
    expect(await routeInput('Nvidia Jensen', known, { llm: known2, ledger })).toMatchObject({ kind: 'person', slug: 'jensen-huang' });
  });

  test('without a model, or when it fails, an ambiguous input is a question', async () => {
    expect(await routeInput('Nvidia China', known, { ledger })).toEqual({ kind: 'ask', text: 'Nvidia China', via: 'rule' });
    const broken = new MockLLM(() => {
      throw new Error('boom');
    });
    expect(await routeInput('Nvidia China', known, { llm: broken, ledger })).toMatchObject({ kind: 'ask', via: 'rule' });
  });
});
