// Fixes from the live QA pass: status pills on non-predictions, the offline
// same-question fallback, discovery mirrors and ordering, lowercase names,
// the year-end window and plain dates in answers.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ANSWER_SYSTEM, answerQuestion, answerUserPrompt } from '../src/ask.ts';
import { rankCandidates, validateCandidates, youtubeMirrorToYouTube } from '../src/discover.ts';
import { analyzeQuestion, resolvePeople, routeInputSync, timeWindow } from '../src/intent.ts';
import { MockLLM } from '../src/llm/mock.ts';
import { RecordingLLM, ReplayLLM } from '../src/llm/replay.ts';
import { humanizeDates, renderAnswerCard, renderAnswerReceipts, renderDiscoveries } from '../src/site/dashboard.ts';
import type { Candidate, Claim } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

const TODAY = '2026-09-27';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'receipts-qa-fixes-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stance = makeClaim({ type: 'stance', targetDate: undefined, saidDate: '2026-09-15', topic: 'nvidia-china-exports', claim: 'Nvidia is apolitical.', quote: "we're bipartisan" });
const pred = makeClaim({ saidDate: '2025-10-22', targetDate: '2026-12-31', topic: 'robotaxi', claim: 'Robotaxis in ten metros by the end of 2026.', quote: 'we will be in ten metro areas by the end of next year' });

describe('answer receipts', () => {
  test('stances and facts never say "Waiting on its deadline"', async () => {
    const l = ledgerOf([stance, pred]);
    const r = await answerQuestion('What has Elon Musk been saying lately?', l, { llm: null, today: TODAY });
    const s = r.receipts.find((c) => c.id === stance.id);
    expect(s?.type).toBe('stance');
    const html = renderAnswerReceipts(r.receipts);
    const li = html.split('<li>').find((x) => x.includes("bipartisan"))!;
    expect(li).toContain('Stance, not a prediction');
    expect(li).not.toContain('Waiting on its deadline');
  });

  test('answer prose shows plain dates', () => {
    expect(humanizeDates('2026-09-15: "x"')).toBe('Sep 15, 2026: "x"');
    const html = renderAnswerCard({ question: 'q', kind: 'general', answer: 'Said on 2019-04-22.', receipts: [], people: [], followUps: [], actions: [], usedModel: false, fromRecording: false });
    expect(html).toContain('Apr 22, 2019');
    expect(html).not.toContain('2019-04-22.');
  });
});

describe('offline fallback for recorded answers', () => {
  test('a recorded answer still replays after new receipts change the prompt', async () => {
    const l1 = ledgerOf([pred]);
    const q = 'What is coming due before the end of the year?';

    const inner = new MockLLM(() => ({ answer: `Elon Musk: ten metros by 2026-12-31: "we will be in ten metro areas by the end of next year".`, cited_claim_ids: [pred.id] }));
    const rec = new RecordingLLM(inner, dir, () => {});
    const live = await answerQuestion(q, l1, { llm: rec, today: TODAY });
    expect(live.usedModel).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith('ask_answer_v2-'))).toBe(true);

    // A later pull adds a receipt that enters the context: the exact prompt changes.
    const extra = makeClaim({ saidDate: '2026-01-10', targetDate: '2026-11-30', topic: 'robotaxi', claim: 'Unsupervised FSD by November.', quote: 'unsupervised by November' });
    const l2 = ledgerOf([pred, extra]);
    const offline = await answerQuestion(q, l2, { llm: new ReplayLLM(dir), today: TODAY });
    expect(offline.fromRecording).toBe(true);
    expect(offline.answer).toBe(live.answer);
    expect(offline.receipts.map((c) => c.id)).toEqual([pred.id]);
  });

  test('no fallback when a cited receipt is gone', async () => {
    const q = 'What is coming due before the end of the year?';
    const inner = new MockLLM(() => ({ answer: `Elon Musk: 2026-12-31: "we will be in ten metro areas by the end of next year".`, cited_claim_ids: [pred.id] }));
    await answerQuestion(q, ledgerOf([pred]), { llm: new RecordingLLM(inner, dir, () => {}), today: TODAY });
    const other = makeClaim({ saidDate: '2026-01-10', targetDate: '2026-11-30', topic: 'robotaxi', claim: 'Unsupervised FSD by November.', quote: 'unsupervised by November' });
    const r = await answerQuestion(q, ledgerOf([other]), { llm: new ReplayLLM(dir), today: TODAY });
    expect(r.fromRecording).toBe(false);
  });

  test('a live discovery never replaces an existing discovery recording', async () => {
    const req = { schemaName: 'discover_appearances', schema: (await import('zod')).z.object({ a: (await import('zod')).z.string() }), system: 's', user: 'u' } as const;
    await new RecordingLLM(new MockLLM(() => ({ a: 'first' })), dir, () => {}).json(req);
    const warned: string[] = [];
    await new RecordingLLM(new MockLLM(() => ({ a: 'second' })), dir, (m) => warned.push(m)).json(req);
    const back = await new ReplayLLM(dir).json(req);
    expect(back.data).toEqual({ a: 'first' });
    expect(warned[0]).toContain('RECEIPTS_RECORD=force');
  });
});

describe('discovery', () => {
  const base: Omit<Candidate, 'url' | 'transcriptSource' | 'date' | 'title'> = { show: 'Show', kind: 'podcast', why: 'Interview.', linkConfirmed: true };
  test('a YouTube mirror becomes a YouTube link', () => {
    expect(youtubeMirrorToYouTube('https://zolotube.com/watch?v=N2Zekittusw')).toBe('https://www.youtube.com/watch?v=N2Zekittusw');
    expect(youtubeMirrorToYouTube('https://example.com/watch?v=short')).toBe('https://example.com/watch?v=short');
    const { kept } = validateCandidates(
      [{ title: 'Dreamforce', show: 'Dreamforce', date: '2026-09-10', url: 'https://zolotube.com/watch?v=N2Zekittusw', kind: 'talk', transcript_source: 'unknown', why: 'Keynote.', host: null, duration_min: 45 } as never],
      { today: TODAY, since: '2026-03-31', searched: [], citations: [] },
    );
    expect(kept[0]?.transcriptSource).toBe('youtube');
  });
  test('readable appearances sort first; the rest fold away', () => {
    const cs: Candidate[] = [
      { ...base, title: 'Audio', url: 'https://podscan.fm/x', transcriptSource: 'audio', date: '2026-09-20' },
      { ...base, title: 'Video', url: 'https://www.youtube.com/watch?v=abcdefghijk', transcriptSource: 'youtube', date: '2026-09-01' },
      { ...base, title: 'News', url: 'https://www.cbsnews.com/video/x', transcriptSource: 'unknown', date: '2026-09-25' },
    ];
    expect(rankCandidates(cs).map((c) => c.title)).toEqual(['Video', 'News', 'Audio']);
    const html = renderDiscoveries('Jensen Huang', 'jensen-huang', { checkedAt: '2026-09-27T12:00:00Z', since: '2026-03-31', candidates: cs.map((c) => ({ ...c, status: 'new' as const })) } as never, new Date('2026-09-27T12:05:00Z'));
    expect(html.indexOf('Video')).toBeLessThan(html.indexOf('cands-more'));
    expect(html).toContain("2 more appearances we can't read yet");
    expect(html).toContain('cbsnews.com');
    expect(html).not.toContain('Unknown source');
  });
});

describe('lowercase names', () => {
  const known = [{ slug: 'elon-musk', name: 'Elon Musk', aliases: [], followed: true }] as never;
  test('a lowercase name alone goes to the router model, not straight to ask', () => {
    expect(routeInputSync('satya nadella', known)).toMatchObject({ kind: 'ambiguous' });
    expect(routeInputSync('robotaxi timelines', known)).toMatchObject({ kind: 'ask' });
  });
  test('a lowercase name inside a question is an unknown name to follow', () => {
    expect(resolvePeople('has satya nadella been right about AI agents?', known).unknownNames).toEqual(['Satya Nadella']);
    expect(resolvePeople('will ai wipe out entry level jobs?', known).unknownNames).toEqual([]);
    expect(resolvePeople('has inflation cooled?', known).unknownNames).toEqual([]);
  });
  test('the answer offers to follow them', async () => {
    const r = await answerQuestion('has satya nadella been right about AI agents?', ledgerOf([pred]), { llm: null, today: TODAY });
    expect(r.actions).toContainEqual({ type: 'follow', name: 'Satya Nadella', label: 'Follow Satya Nadella and find their interviews' });
  });
});

describe('questions', () => {
  test('before the end of the year is a deadline window', () => {
    expect(timeWindow("What's coming due before the end of the year?", TODAY)).toEqual({ from: '2026-09-28', to: '2026-12-31', field: 'targetDate', label: 'before the end of the year' });
  });
  test("what's new lists the newest pulls for the model", () => {
    const fresh: Claim = { ...stance, origin: 'extracted', extractedAt: '2026-09-26T10:00:00.000Z' } as Claim;
    const l = ledgerOf([fresh, pred]);
    const plan = analyzeQuestion("what's new?", l, TODAY);
    expect(plan.kind).toBe('recent');
    const prompt = answerUserPrompt("what's new?", plan, [fresh, pred], { today: TODAY, people: [] });
    expect(prompt).toContain('Recently added (newest pull first):\n- 2026-09-26: 2 from Elon Musk');
    expect(ANSWER_SYSTEM).toContain('Quote at most three short phrases');
  });
});
