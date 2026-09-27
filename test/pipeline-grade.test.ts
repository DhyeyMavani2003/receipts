import { describe, expect, test } from 'bun:test';

import {
  DEADLINE_RULE,
  GRADE_SYSTEM,
  MAX_EVIDENCE,
  combineVotes,
  gradeClaim,
  gradeDue,
  gradeUserPrompt,
  latenessMonths,
  mergeEvidence,
  UnverifiedGradeError,
  verifiedEvidence,
  normalizeConfidence,
  urlKey,
  zGradeClaim,
} from '../src/grade.ts';
import type { GradeOutput, JudgeResult } from '../src/grade.ts';
import { MockLLM } from '../src/llm/mock.ts';
import type { Citation, JsonRequest } from '../src/llm/provider.ts';
import { toOpenAISchema } from '../src/llm/schema.ts';
import type { FinalVerdict } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

const TODAY = '2026-09-27';

const SOURCE = { url: 'https://news.example/outcome', title: 'Outcome report', date: null, snippet: '' };

/** A judge's answer; outcome verdicts cite one source unless `over` says otherwise. */
function output(verdict: FinalVerdict, over: Partial<GradeOutput> = {}): GradeOutput {
  const evidence = verdict === 'unresolvable' || verdict === 'too_early' ? [] : [SOURCE];
  return { verdict, confidence: 0.8, rationale: `Judged ${verdict}.`, resolvedOn: null, evidence, ...over };
}

function vote(judge: string, verdict: FinalVerdict, confidence = 0.8, citations: Citation[] = []): JudgeResult {
  return { judge, model: 'mock', output: output(verdict, { confidence }), citations, searched: [] };
}

/**
 * Mock grader answering per judge variant. Like the live API, each judge's
 * web search returns the URLs it cites (plus any `extra` citations).
 */
function judges(byVariant: Record<string, GradeOutput | (() => never)>, extra?: (req: JsonRequest<unknown>) => Citation[]) {
  const searched = (req: JsonRequest<unknown>): Citation[] => {
    const answer = byVariant[req.variant ?? ''];
    return typeof answer === 'object' ? answer.evidence.map((e) => ({ url: e.url })) : [];
  };
  return new MockLLM(
    (req) => {
      const answer = byVariant[req.variant ?? ''];
      if (!answer) throw new Error(`unexpected judge ${req.variant}`);
      return typeof answer === 'function' ? answer() : answer;
    },
    { model: 'gpt-test', citations: (req) => [...searched(req), ...(extra?.(req) ?? [])] },
  );
}

const robotaxi = makeClaim({ saidDate: '2019-04-22', targetDate: '2020-12-31', claim: 'Tesla will have one million robotaxis on the road by the end of 2020.' });

describe('combineVotes', () => {
  test('agreement: that verdict, mean confidence', () => {
    expect(combineVotes([vote('A', 'incorrect', 0.9), vote('B', 'incorrect', 0.6)])).toMatchObject({
      verdict: 'incorrect',
      confidence: 0.75,
      disputed: false,
    });
  });

  test('disagreement settled by the tie-break: the majority wins, with its confidence', () => {
    const c = combineVotes([vote('A', 'incorrect', 0.9), vote('B', 'correct', 0.7), vote('C', 'correct', 0.5)]);
    expect(c).toMatchObject({ verdict: 'correct', confidence: 0.6, disputed: false });
    expect(c.winners.map((w) => w.judge)).toEqual(['B', 'C']);
  });

  test('no majority: unresolvable and disputed', () => {
    const c = combineVotes([vote('A', 'incorrect'), vote('B', 'correct'), vote('C', 'partial')]);
    expect(c).toMatchObject({ verdict: 'unresolvable', disputed: true, confidence: 0.5 });
    expect(c.winners).toHaveLength(3);
  });

  test('a lone judge decides; percent confidences are normalized', () => {
    expect(combineVotes([vote('A', 'partial', 80)])).toMatchObject({ verdict: 'partial', confidence: 0.8 });
    expect(normalizeConfidence(-1)).toBe(0);
    expect(normalizeConfidence(0.42)).toBe(0.42);
    expect(normalizeConfidence(Number.NaN)).toBe(0);
  });
});

describe('gradeClaim', () => {
  test('a future deadline is too_early without calling the model', async () => {
    const llm = judges({});
    const g = await gradeClaim(makeClaim({ targetDate: '2027-01-01' }), llm, { today: TODAY });
    expect(llm.calls).toHaveLength(0);
    expect(g).toMatchObject({ verdict: 'too_early', gradedBy: DEADLINE_RULE, evidence: [], confidence: 1 });
    expect(g.rationale).toContain('2027-01-01');
  });

  test('an outcome verdict with no verified evidence is not recorded', async () => {
    const noSearch = new MockLLM(() => output('incorrect', { evidence: [{ url: 'https://www.reuters.com/made-up', title: 't', date: null, snippet: '' }] }), {
      model: 'gpt-test',
    });
    await expect(gradeClaim(robotaxi, noSearch, { today: TODAY })).rejects.toBeInstanceOf(UnverifiedGradeError);
    const bare = judges({ A: output('incorrect', { evidence: [] }), B: output('incorrect', { evidence: [] }) });
    await expect(gradeClaim(robotaxi, bare, { today: TODAY })).rejects.toThrow(/no verdict is recorded/);
  });

  test('pages the search only read are not evidence (live answers carry no citations, only search results)', async () => {
    const report = { url: 'https://other.example/report', title: 'Report', date: '2021-01-10', snippet: 'what happened' };
    const live = (answers: Record<string, GradeOutput>) =>
      new MockLLM((req) => answers[req.variant ?? ''], {
        model: 'gpt-test',
        searched: () => [{ url: 'https://unrelated.example/q2-earnings' }, { url: report.url }],
      });
    const uncited = live({ A: output('incorrect', { evidence: [] }), B: output('incorrect', { evidence: [] }) });
    await expect(gradeClaim(robotaxi, uncited, { today: TODAY })).rejects.toBeInstanceOf(UnverifiedGradeError);
    const unresolvable = await gradeClaim(robotaxi, live({ A: output('unresolvable'), B: output('unresolvable') }), { today: TODAY });
    expect(unresolvable.evidence).toEqual([]);
    // A result page the judge names is confirmed by its own search and kept; the other stays out.
    const named = live({ A: output('incorrect', { evidence: [report] }), B: output('incorrect', { evidence: [] }) });
    expect((await gradeClaim(robotaxi, named, { today: TODAY })).evidence.map((e) => e.url)).toEqual([report.url]);
  });

  test('unresolvable needs no evidence', async () => {
    const g = await gradeClaim(robotaxi, judges({ A: output('unresolvable'), B: output('unresolvable') }), { today: TODAY });
    expect(g).toMatchObject({ verdict: 'unresolvable', evidence: [] });
  });

  test('an unresolvable verdict stores no links, even ones the judges named and searched', async () => {
    // Live: a judge named an unrelated PDF and a generic portal on its unresolvable verdict.
    const named = [
      { url: 'https://unrelated.example/training.pdf', title: 'Unrelated case', date: '2015-03-01', snippet: '' },
      { url: 'https://portal.example/en/', title: 'Invest here', date: null, snippet: '' },
    ];
    const g = await gradeClaim(robotaxi, judges({ A: output('unresolvable', { evidence: named }), B: output('unresolvable') }), { today: TODAY });
    expect(g).toMatchObject({ verdict: 'unresolvable', evidence: [] });
  });

  test('a loaded rationale is replaced with a neutral sentence', async () => {
    const evidence = [{ url: 'https://news.example/robotaxi-2021', title: 'No robotaxis yet', date: '2021-01-05', snippet: '' }];
    const loaded = 'Musk lied: he misled investors and broke his promise.';
    const g = await gradeClaim(
      robotaxi,
      judges({ A: output('incorrect', { rationale: loaded, evidence }), B: output('incorrect', { rationale: loaded, evidence }) }),
      { today: TODAY },
    );
    expect(g.rationale).toBe('The target was not met by 2020-12-31. See the evidence links.');
  });

  test('two agreeing judges: two web-search grader calls, votes recorded, evidence merged', async () => {
    const llm = judges(
      {
        A: output('incorrect', {
          confidence: 0.9,
          rationale: 'No robotaxi service operated in 2020.',
          evidence: [{ url: 'https://news.example/robotaxi-2021', title: 'No robotaxis yet', date: '2021-01-05', snippet: 'Still no robotaxis.' }],
        }),
        B: output('incorrect', {
          confidence: 0.7,
          evidence: [{ url: 'https://www.news.example/robotaxi-2021/?utm_source=x', title: 'dup', date: null, snippet: '' }],
        }),
      },
      () => [{ url: 'https://regulator.example/report', title: 'Regulator report' }],
    );
    const g = await gradeClaim(robotaxi, llm, { today: TODAY });
    expect(llm.calls.map((r) => r.variant)).toEqual(['A', 'B']);
    for (const req of llm.calls) {
      expect(req).toMatchObject({ schemaName: 'grade_claim', system: GRADE_SYSTEM, webSearch: true, role: 'grader' });
    }
    expect(g).toMatchObject({
      verdict: 'incorrect',
      confidence: 0.8,
      rationale: 'No robotaxi service operated in 2020.',
      gradedBy: 'gpt-test',
      latenessMonths: null,
      judges: [
        { judge: 'gpt-test#A', verdict: 'incorrect', confidence: 0.9 },
        { judge: 'gpt-test#B', verdict: 'incorrect', confidence: 0.7 },
      ],
    });
    expect(g.disputed).toBeUndefined();
    expect(g.evidence.map((e) => e.url)).toEqual(['https://news.example/robotaxi-2021', 'https://regulator.example/report']);
  });

  test('disagreement calls judge C; its side wins and speaks', async () => {
    const llm = judges({
      A: output('incorrect', { confidence: 0.9 }),
      B: output('correct', { confidence: 0.6, resolvedOn: '2021-02-10', rationale: 'Happened in February 2021.' }),
      C: output('correct', { confidence: 0.8, resolvedOn: '2021-02-10', rationale: 'Came true about six weeks late.' }),
    });
    const g = await gradeClaim(robotaxi, llm, { today: TODAY });
    expect(llm.calls.map((r) => r.variant)).toEqual(['A', 'B', 'C']);
    expect(g).toMatchObject({ verdict: 'correct', confidence: 0.7, rationale: 'Came true about six weeks late.', resolvedOn: '2021-02-10' });
    expect(g.latenessMonths).toBe(1.3);
    expect(g.judges).toHaveLength(3);
  });

  test('three different verdicts: unresolvable, disputed, neutral rationale', async () => {
    const llm = judges({ A: output('incorrect'), B: output('correct', { resolvedOn: '2021-02-10' }), C: output('partial') });
    const g = await gradeClaim(robotaxi, llm, { today: TODAY });
    expect(g).toMatchObject({ verdict: 'unresolvable', disputed: true, confidence: 0.5, evidence: [] });
    expect(g.rationale).toBe('The judges disagreed (strict reading: incorrect, charitable reading: correct, tie-break: partial), so no verdict is recorded.');
    expect(g.resolvedOn).toBeUndefined();
    expect(g.latenessMonths).toBeUndefined();
  });

  test('judges: 1 asks only the strict judge; judges: 3 asks all three up front', async () => {
    const one = judges({ A: output('correct', { resolvedOn: '2020-06-01' }) });
    const g1 = await gradeClaim(robotaxi, one, { today: TODAY, judges: 1 });
    expect(one.calls.map((r) => r.variant)).toEqual(['A']);
    expect(g1).toMatchObject({ verdict: 'correct', latenessMonths: 0 });

    const three = judges({ A: output('correct'), B: output('correct'), C: output('incorrect') });
    const g3 = await gradeClaim(robotaxi, three, { today: TODAY, judges: 3 });
    expect(three.calls.map((r) => r.variant).sort()).toEqual(['A', 'B', 'C']);
    expect(g3.verdict).toBe('correct');
  });
});

describe('gradeUserPrompt and schema', () => {
  test('names the judge role, today, the verbatim quote and the deadline', () => {
    const p = gradeUserPrompt({ ...robotaxi, targetDateInferred: true }, TODAY, 'B');
    expect(p).toContain('Judge: B (charitable reading of what the speaker meant)');
    expect(p).toContain(`Today: ${TODAY}`);
    expect(p).toContain(`Quote (verbatim): "${robotaxi.quote}"`);
    expect(p).toContain('Deadline: 2020-12-31 (inferred');
    expect(p).toBe(gradeUserPrompt({ ...robotaxi, targetDateInferred: true }, TODAY, 'B'));
    expect(gradeUserPrompt({ ...robotaxi, targetDate: undefined }, TODAY, 'A')).toContain('Deadline: none stated');
  });

  test('system prompt carries the grading rules', () => {
    for (const rule of ['independent evidence', 'after the deadline', 'own later words are not evidence', 'never guess or construct', 'partial: materially mixed', 'too_early', 'A, strict', 'B, charitable', 'never "lied"']) {
      expect(GRADE_SYSTEM).toContain(rule);
    }
  });

  test('output schema is valid for OpenAI strict mode', () => {
    expect(toOpenAISchema(zGradeClaim).required).toEqual(['verdict', 'confidence', 'rationale', 'resolvedOn', 'evidence']);
  });
});

describe('latenessMonths', () => {
  test.each([
    ['correct', '2020-12-31', '2020-11-01', 0],
    ['correct', '2020-12-31', '2023-06-30', 29.9],
    ['partial', '2020-12-31', '2021-03-31', 3],
    ['incorrect', '2020-12-31', '2022-12-31', 24],
    // A day late is late, never "0 months".
    ['correct', '2020-12-31', '2021-01-01', 0.1],
    ['incorrect', '2020-12-31', undefined, null],
    ['correct', '2020-12-31', undefined, undefined],
    ['unresolvable', '2020-12-31', '2022-01-01', undefined],
    ['correct', undefined, '2022-01-01', undefined],
  ] as const)('%s, due %s, resolved %s -> %p', (verdict, target, resolved, expected) => {
    expect(latenessMonths(verdict, target, resolved)).toBe(expected);
  });
});

describe('mergeEvidence', () => {
  const claim = { targetDate: '2020-12-31', source: robotaxi.source };
  const ev = (url: string, date: string | null = null) => ({ url, title: '', date, snippet: '' });

  test('takes judges in turn, puts post-deadline sources first, dedupes URLs, drops the claim source and bad URLs, caps at five', () => {
    const results: JudgeResult[] = [
      {
        judge: 'A',
        model: 'm',
        output: output('incorrect', {
          evidence: [
            ev('https://a.example/before', '2019-06-01'),
            ev('https://a.example/after', '2021-03-01'),
            ev(robotaxi.source.url, '2019-04-22'),
            ev('not a url'),
            ev('https://A.example/after/#section', null),
          ],
        }),
        // Search results: the cited pages, found as the model cited them.
        citations: [{ url: 'https://c.example/1', title: 'C1' }, { url: 'https://c.example/2' }, { url: 'https://a.example/before' }, { url: 'https://www.a.example/after/' }],
        searched: [],
      },
      {
        judge: 'B',
        model: 'm',
        output: output('incorrect', { evidence: [ev('https://b.example/x', '2022-01-01'), ev('https://b.example/y')] }),
        citations: [{ url: 'https://c.example/3' }, { url: 'https://b.example/x' }, { url: 'https://b.example/y' }],
        searched: [],
      },
    ];
    const merged = mergeEvidence(results, claim);
    expect(merged.map((e) => e.url)).toEqual([
      'https://b.example/x',
      'https://a.example/after',
      'https://a.example/before',
      'https://b.example/y',
      'https://c.example/1',
    ]);
    expect(merged).toHaveLength(MAX_EVIDENCE);
    expect(merged[1]).toEqual({ url: 'https://a.example/after', date: '2021-03-01' });
    expect(merged[4]).toEqual({ url: 'https://c.example/1', title: 'C1' });
  });

  test('a partial verdict keeps the sources for the part that was met, even when later reports fill the cap', () => {
    // Live, Meta AI "leading assistant with 1B users in 2025": the met half (1B monthly users,
    // May 2025) is dated before the deadline; each judge also named several 2026 reports.
    const meta = { targetDate: '2025-12-31', source: robotaxi.source };
    const later = (judge: string, n: number) => Array.from({ length: n }, (_, i) => ev(`https://${judge}.example/2026-report-${i}`, '2026-02-01'));
    const partial = (judge: string, evidence: ReturnType<typeof ev>[]): JudgeResult => ({
      judge,
      model: 'm',
      output: output('partial', { evidence }),
      citations: [],
      searched: evidence.map((e) => ({ url: e.url })),
    });
    const met = ev('https://news.example/meta-ai-1b-monthly-users', '2025-05-29');
    const rival = ev('https://news.example/chatgpt-800m-weekly-users', '2025-10-06');
    const merged = mergeEvidence([partial('A', [met, ...later('a', 4)]), partial('C', [...later('c', 3), rival])], meta);
    expect(merged).toHaveLength(MAX_EVIDENCE);
    expect(merged.map((e) => e.url)).toContain(met.url);
    expect(merged.slice(0, 3).every((e) => e.date === '2026-02-01')).toBe(true);
  });

  test("a URL the judge's web search never returned is dropped", () => {
    const invented: JudgeResult = {
      judge: 'A',
      model: 'm',
      output: output('incorrect', { evidence: [ev('https://www.reuters.com/made-up-article-that-does-not-exist', '2021-01-01')] }),
      citations: [],
      searched: [],
    };
    expect(verifiedEvidence(invented)).toEqual([]);
    expect(mergeEvidence([invented], claim)).toEqual([]);
  });

  test('pages the search only read verify a judge\'s URL but are never padded in', () => {
    const r: JudgeResult = {
      judge: 'A',
      model: 'm',
      output: output('incorrect', { evidence: [ev('https://www.read.example/report/', '2021-02-01')] }),
      citations: [],
      searched: [{ url: 'https://read.example/report' }, { url: 'https://unrelated.example/q2-earnings' }],
    };
    expect(verifiedEvidence(r).map((e) => e.url)).toEqual(['https://www.read.example/report/']);
    expect(mergeEvidence([r], claim).map((e) => e.url)).toEqual(['https://www.read.example/report/']);
    expect(mergeEvidence([{ ...r, output: output('incorrect', { evidence: [] }) }], claim)).toEqual([]);
  });

  test('urlKey ignores www, case of host, hash, utm params and trailing slashes', () => {
    expect(urlKey('https://www.Example.com/a/?utm_medium=x&id=2#top')).toBe(urlKey('https://example.com/a?id=2'));
    expect(urlKey('ftp://example.com/file')).toBeNull();
    expect(urlKey('https://cdn.example/r.pdf?id=2&X-Amz-Signature=abc&Authorization=Bearer%20x')).toBe(urlKey('https://cdn.example/r.pdf?id=2'));
    expect(urlKey('nope')).toBeNull();
  });
});

describe('gradeDue', () => {
  test('grades due predictions into the ledger and skips ones that fail', async () => {
    const due = makeClaim({ claim: 'Due one.', targetDate: '2025-12-31' });
    const failing = makeClaim({ claim: 'Fails to grade.', targetDate: '2026-01-31' });
    const future = makeClaim({ claim: 'Not due.', targetDate: '2027-12-31' });
    const stance = makeClaim({ claim: 'A stance.', type: 'stance', targetDate: undefined });
    const l = ledgerOf([due, failing, future, stance]);
    const llm = new MockLLM((req) => {
      if (req.user.includes('Fails to grade.')) throw new Error('no fixture');
      return output('correct', { resolvedOn: '2025-11-01' });
    }, { citations: () => [{ url: SOURCE.url }] });
    const messages: string[] = [];
    const updated = await gradeDue(l, llm, { today: TODAY, onProgress: (e) => messages.push(e.message) });

    expect(updated.map((c) => c.id)).toEqual([due.id]);
    expect(updated[0]).toMatchObject({ verdict: 'correct', grading: { verdict: 'correct', latenessMonths: 0 } });
    expect(l.claims.find((c) => c.id === due.id)?.verdict).toBe('correct');
    expect(l.claims.find((c) => c.id === failing.id)?.verdict).toBe('pending');
    expect(l.claims.find((c) => c.id === future.id)?.grading).toBeUndefined();
    expect(messages.some((m) => m.startsWith('Not graded: no fixture'))).toBe(true);
  });

  test('respects limit and personSlug', async () => {
    const a = makeClaim({ claim: 'A.', targetDate: '2025-01-31' });
    const b = makeClaim({ claim: 'B.', targetDate: '2025-02-28' });
    const other = makeClaim({ claim: 'C.', personSlug: 'sam-altman', person: 'Sam Altman', targetDate: '2025-01-01' });
    const llm = judges({ A: output('incorrect'), B: output('incorrect') });
    const l = ledgerOf([a, b, other]);
    const updated = await gradeDue(l, llm, { today: TODAY, personSlug: 'elon-musk', limit: 1 });
    expect(updated.map((c) => c.id)).toEqual([a.id]);
  });
});
