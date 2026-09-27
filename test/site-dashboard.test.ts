import { describe, expect, test } from 'bun:test';

import { renderAnswerCard, renderCandidateRow, renderDashboard, renderDiscoveries, renderPersonCard, renderPersonV2 } from '../src/site/dashboard.ts';
import { buildFeed, FEED_MAX } from '../src/site/feed.ts';
import { modeBadge, recordLine } from '../src/site/theme.ts';
import type { AnswerResult, Candidate, Claim, DiscoveryStore, Ledger, Watchlist } from '../src/types.ts';
import { sampleLedger } from './site-fixtures.ts';

const TODAY = '2026-09-27';
const EMPTY_D: DiscoveryStore = { version: 1, bySlug: {} };
const EMPTY_W: Watchlist = { version: 1, people: [] };

function claim(over: Partial<Claim>): Claim {
  const base = sampleLedger().claims[0]!;
  return { ...base, drift: undefined, grading: undefined, ...over };
}

describe('recordLine', () => {
  const zero = { correct: 0, incorrect: 0, partial: 0, pending: 0, tooEarly: 0, claims: 0 };
  test('graded, with partial and waiting', () => {
    expect(recordLine({ ...zero, correct: 4, incorrect: 8, partial: 1, pending: 6, tooEarly: 2, claims: 30 })).toBe('4 of 13 came true, 1 partly · 8 waiting');
  });
  test('graded only', () => {
    expect(recordLine({ ...zero, correct: 1, incorrect: 1, claims: 2 })).toBe('1 of 2 came true');
  });
  test('only waiting', () => {
    expect(recordLine({ ...zero, pending: 3, claims: 3 })).toBe('3 predictions waiting on their deadline');
    expect(recordLine({ ...zero, tooEarly: 1, claims: 1 })).toBe('1 prediction waiting on its deadline');
  });
  test('no claims', () => {
    expect(recordLine(zero)).toBe('No receipts yet');
  });
});

describe('buildFeed', () => {
  test('came due, coming due, new receipts and discoveries, sorted newest first and capped', () => {
    const l: Ledger = {
      version: 1,
      updatedAt: '2026-09-27T00:00:00.000Z',
      claims: [
        claim({ id: 'a', type: 'prediction', targetDate: '2026-09-20', verdict: 'correct', claim: 'Ten cities' }),
        claim({ id: 'b', type: 'prediction', targetDate: '2026-10-15', verdict: 'pending', claim: 'Mars launch' }),
        claim({ id: 'c', type: 'prediction', targetDate: '2026-01-01', verdict: 'incorrect', claim: 'Too old' }),
        claim({ id: 'd', origin: 'extracted', extractedAt: '2026-09-25T10:00:00.000Z', source: { title: 'All-In', url: 'https://youtu.be/x', date: '2026-09-20', kind: 'podcast' } }),
        claim({ id: 'e', origin: 'extracted', extractedAt: '2026-09-25T10:00:00.000Z', source: { title: 'All-In', url: 'https://youtu.be/x', date: '2026-09-20', kind: 'podcast' } }),
      ],
    };
    const d: DiscoveryStore = {
      version: 1,
      bySlug: { 'jensen-huang': { checkedAt: '2026-09-26T08:00:00.000Z', since: '2026-03-31', candidates: [{ ...cand(), status: 'new', foundAt: '2026-09-26T08:00:00.000Z' }] } },
    };
    const w: Watchlist = { version: 1, people: [{ name: 'Jensen Huang', slug: 'jensen-huang', followedAt: '2026-09-26T08:00:00.000Z' }] };
    const items = buildFeed(l, d, w, TODAY);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain('came_due');
    expect(kinds).toContain('coming_due');
    expect(kinds).toContain('discovered');
    expect(items.find((i) => i.kind === 'new_receipts')!.text).toBe(`2 new receipts from "All-In" (${l.claims[0]!.person})`);
    expect(items.find((i) => i.kind === 'came_due')!.text).toContain('Came true.');
    expect(items.find((i) => i.kind === 'coming_due')!.text).toStartWith('Due Oct 15, 2026');
    expect(items.find((i) => i.kind === 'discovered')!.text).toBe('Found 1 new appearance for Jensen Huang');
    expect(items.some((i) => i.text.includes('Too old'))).toBe(false);
    const dates = items.map((i) => i.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  test('caps at 8', () => {
    const claims = Array.from({ length: 20 }, (_, i) => claim({ id: `x${i}`, type: 'prediction', targetDate: `2026-10-${String(i + 1).padStart(2, '0')}`, verdict: 'pending' }));
    expect(buildFeed({ version: 1, updatedAt: '', claims }, EMPTY_D, EMPTY_W, TODAY)).toHaveLength(FEED_MAX);
  });
});

function cand(over: Partial<Candidate> = {}): Candidate {
  return {
    title: 'All-In Summit: Jensen Huang on AI factories',
    show: 'All-In Podcast',
    date: '2026-09-06',
    url: 'https://www.youtube.com/watch?v=abc123',
    kind: 'podcast',
    durationMin: 58,
    transcriptSource: 'youtube',
    why: 'Long sit-down on China export rules and AGI timing.',
    linkConfirmed: true,
    ...over,
  };
}

describe('rendering', () => {
  test('candidate rows escape model-written text and show the right action per status', () => {
    const html = renderCandidateRow(cand({ title: '<script>alert(1)</script>', why: '"><img src=x>' }), 'jensen-huang');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('Pull receipts');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Sep 6, 2026 · 58 min · YouTube');
    expect(renderCandidateRow(cand({ transcriptSource: 'audio' }), 's')).toContain('No transcript we can read');
    expect(renderCandidateRow({ ...cand(), status: 'pulled', foundAt: '', receipts: 9 }, 's')).toContain('Pulled: 9 receipts');
    expect(renderCandidateRow({ ...cand(), status: 'have', foundAt: '' }, 's')).toContain('Already in your receipts');
    expect(renderCandidateRow({ ...cand(), status: 'failed', foundAt: '', error: 'boom' }, 's')).toContain('Could not pull: boom');
    expect(renderCandidateRow(cand({ linkConfirmed: false }), 's')).toContain('link not confirmed by search');
  });

  test('discoveries panel: empty state and header', () => {
    const now = new Date('2026-09-27T12:00:00Z');
    const html = renderDiscoveries('Jensen Huang', 'jensen-huang', { checkedAt: '2026-09-27T11:58:00Z', since: '2026-03-31', candidates: [] }, now);
    expect(html).toContain('Recent appearances for Jensen Huang');
    expect(html).toContain('checked 2 min ago · since Mar 31, 2026');
    expect(html).toContain('No new long-form appearances found since Mar 31, 2026.');
    expect(html).toContain('Search again');
  });

  test('person card for a followed person never checked', () => {
    const html = renderPersonCard({ name: 'Lisa Su', slug: 'lisa-su', followed: true, record: 'No receipts yet', waiting: 0, claims: 0, newAppearances: 0 });
    expect(html).toContain('Not checked yet.');
    expect(html).toContain('Find recent appearances');
    expect(html).toContain('Following ✓');
    expect(html).toContain('href="/p/lisa-su"');
  });

  test('answer card escapes the answer and renders actions and follow-ups', () => {
    const a: AnswerResult = {
      question: 'Is <b>Lisa Su</b> right?',
      kind: 'track_record',
      answer: 'I have no receipts for <Lisa Su> yet.',
      receipts: [],
      people: [],
      followUps: ['Who has been most wrong about robotaxis?'],
      actions: [{ type: 'follow', name: 'Lisa Su', label: 'Follow Lisa Su and find their interviews' }],
      usedModel: false,
      fromRecording: false,
    };
    const html = renderAnswerCard(a, 'A note.');
    expect(html).toContain('&lt;Lisa Su&gt;');
    expect(html).not.toContain('<b>Lisa');
    expect(html).toContain('data-follow="Lisa Su"');
    expect(html).toContain('data-q="Who has been most wrong about robotaxis?"');
    expect(html).toContain('A note.');
  });

  test('dashboard: one box, badge, no external fonts, empty states', () => {
    const html = renderDashboard({ today: TODAY, cards: [], alsoOnRecord: [], feed: [], chips: ['follow Jensen Huang'], emptyLedger: true }, { nonce: 'n1', mode: 'replay' });
    expect(html).toContain('placeholder="Follow someone, paste a link, or ask a question"');
    expect(html).toContain('Offline replay');
    expect(html).toContain('Start by following someone, for example: follow Jensen Huang');
    expect(html).toContain('You are not following anyone yet.');
    expect(html).toContain('Nothing new yet. Follow someone or paste a link to get started.');
    expect(html).toContain('<script nonce="n1">');
    expect(html).not.toContain('googleapis');
    expect(html).toContain('<form id="ingest-form"');
  });

  test('mode badges', () => {
    expect(modeBadge('live')).toContain('Live');
    expect(modeBadge('no-key')).toContain('Offline: no API key');
  });

  test('person page for someone with receipts, and for a followed person with none', () => {
    const l = sampleLedger();
    const html = renderPersonV2(l, 'mara-quill', { nonce: 'n', mode: 'live' });
    expect(html).toContain('<h1>Mara Quill</h1>');
    expect(html).toContain('How their views moved');
    expect(html).toContain('data-filter="correct"');
    expect(html).toContain('Scores and calibration');
    expect(html).toContain('0.25 is a coin flip');
    const empty = renderPersonV2(l, 'lisa-su', { nonce: 'n', mode: 'live', followed: { name: 'Lisa Su' } });
    expect(empty).toContain('<h1>Lisa Su</h1>');
    expect(empty).toContain('No receipts yet');
    expect(empty).toContain('Recent appearances');
  });
});
