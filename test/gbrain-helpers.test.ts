import { describe, expect, test } from 'bun:test';
import {
  cleanText,
  displayCommand,
  driftChainLines,
  findMatchingTake,
  formatWeight,
  GBrain,
  GBrainMissingError,
  gbrainQuality,
  forgetBrainLinks,
  needsSync,
  parseAddedTakeRow,
  resolvableQuality,
  parseErrorCode,
  parseJsonOutput,
  parsePageRead,
  parseTakeRows,
  personTemplate,
  renderTrackRecord,
  spliceTrackRecord,
  takeClaimText,
  takeKind,
  takesAddArgs,
  takesResolveArgs,
  timelineAddArgs,
  TRACK_RECORD_BEGIN,
  TRACK_RECORD_END,
  type TakeRow,
} from '../src/gbrain.ts';
import { scorePerson } from '../src/score.ts';
import type { Claim } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

const YT = 'https://www.youtube.com/watch?v=abc123&t=134s';

function claim(over: Partial<Claim> = {}): Claim {
  return makeClaim({
    source: { title: 'Example Podcast #12', url: 'https://www.youtube.com/watch?v=abc123', date: '2019-04-22', kind: 'podcast', deepLink: YT },
    hedge: 'definitely',
    impliedProbability: 0.95,
    ...over,
  });
}

// A page exactly as `gbrain get` returns it after timeline-add, takes add and takes resolve.
const GBRAIN_PAGE = `---
type: person
title: Jane Doe
ingested_at: '2026-09-27T06:07:20.586Z'
source_kind: put_page
ingested_via: put_page
tags:
  - receipts
---

# Jane Doe

> Public figure tracked by Receipts: a track record on public statements.

## State
[No data yet]

## Open Threads
[No data yet]

<!-- timeline -->

## Timeline

- **2019-04-22** | manual — Example Pod #1 — "we will ship it" https://youtu.be/abc?t=12s
  receipts: type=prediction topic=robot due=2020-12-31 hedge="" p=0.85

## Takes

<!--- gbrain:takes:begin -->

| # | claim | kind | who | weight | since | source | resolved | quality | evidence | value | unit | by |
|---|-------|------|-----|--------|-------|--------|----------|---------|----------|-------|------|----|
| 1 | Robot ships (deadline 2020-12-31) | bet | people/jane-doe | 0.85 | 2019-04 | Example Pod #1 2019-04-22 https://youtu.be/abc?t=12s | 2026-09-27 | incorrect | https://example.com/ev |  |  | receipts |
| 2 | has \\| pipe | take | people/jane-doe | 0.5 | 2019-04 |  |  |  |  |  |  |  |
<!--- gbrain:takes:end -->
`;

function fenceAndTimeline(md: string): string {
  return md.slice(md.indexOf('<!-- timeline -->'));
}

describe('text and argv builders', () => {
  test('cleanText keeps a takes cell to one safe line', () => {
    expect(cleanText('  --a | b\n c  ')).toBe('a / b c');
    expect(cleanText('plain')).toBe('plain');
  });

  test('claim types map to take kinds and verdicts to resolution qualities', () => {
    expect([takeKind('prediction'), takeKind('stance'), takeKind('factual')]).toEqual(['bet', 'take', 'fact']);
    expect(['correct', 'incorrect', 'partial', 'unresolvable'].map((v) => gbrainQuality(v as Claim['verdict']))).toEqual([
      'correct', 'incorrect', 'partial', 'unresolvable',
    ]);
    expect(gbrainQuality('too_early')).toBeNull();
    expect(gbrainQuality('pending')).toBeNull();
  });

  test('formatWeight drops float noise', () => {
    expect(formatWeight(0.1 + 0.7)).toBe('0.8');
    expect(formatWeight(0.85)).toBe('0.85');
  });

  test('takes add argv: bet with deadline suffix, holder = the speaker, weight = implied probability', () => {
    const c = claim({ claim: 'Tesla will | have robotaxis.', targetDate: '2020-12-31' });
    expect(takesAddArgs(c)).toEqual([
      'takes', 'add', 'people/elon-musk',
      '--claim=Tesla will / have robotaxis. (deadline 2020-12-31)',
      '--kind', 'bet',
      '--who', 'people/elon-musk',
      '--weight', '0.95',
      `--source=Example Podcast #12 2019-04-22 ${YT}`,
      '--since', '2019-04',
    ]);
  });

  test('stances become takes without a deadline suffix; source falls back to the canonical url', () => {
    const c = claim({ type: 'stance', targetDate: undefined, claim: 'Home robots are the next platform.' });
    c.source = { ...c.source, deepLink: undefined };
    const args = takesAddArgs(c);
    expect(takeClaimText(c)).toBe('Home robots are the next platform.');
    expect(args).toContain('take');
    expect(args).toContain('--source=Example Podcast #12 2019-04-22 https://www.youtube.com/watch?v=abc123');
  });

  test('timeline-add argv keeps the quote verbatim (pipes included) with the deep link in the summary', () => {
    const c = claim({ quote: 'Definitely, we will ship | next year', targetDate: '2020-12-31', topic: 'robot-launch' });
    expect(timelineAddArgs(c)).toEqual([
      'timeline-add', 'people/elon-musk', '2019-04-22',
      `--summary=Example Podcast #12 — "Definitely, we will ship | next year" ${YT}`,
      '--detail=receipts: type=prediction topic=robot-launch due=2020-12-31 hedge="definitely" p=0.95',
    ]);
    expect(timelineAddArgs(claim({ quoteVerified: false }))[4]).toEndWith(' quote=unverified');
  });

  test('takes resolve argv, with and without evidence', () => {
    expect(takesResolveArgs('people/x', 3, 'partial', 'https://e.com/a')).toEqual([
      'takes', 'resolve', 'people/x', '--row', '3', '--quality', 'partial', '--evidence=https://e.com/a', '--by', 'receipts',
    ]);
    expect(takesResolveArgs('people/x', 3, 'unresolvable')).not.toContain('--evidence');
  });

  test('displayCommand quotes for display only', () => {
    expect(displayCommand('gbrain', ['takes', '--claim=it\'s "big"', '--row', '2'])).toBe(`gbrain takes '--claim=it'\\''s "big"' --row 2`);
  });
});

describe('output parsers', () => {
  test('parseAddedTakeRow reads plain, noisy and --json output', () => {
    expect(parseAddedTakeRow('Added take #7 to people/jane-doe.\n')).toBe(7);
    expect(parseAddedTakeRow('[notice] something\nAdded take #12 to people/x.')).toBe(12);
    expect(parseAddedTakeRow('{\n  "row_num": 3,\n  "slug": "people/x"\n}')).toBe(3);
    expect(() => parseAddedTakeRow('Updated take #2')).toThrow('Added take #N');
  });

  test('parseJsonOutput skips notices printed before the JSON', () => {
    expect(parseJsonOutput('[]')).toEqual([]);
    expect(parseJsonOutput('[config] notice line\n{\n  "a": 1\n}\n')).toEqual({ a: 1 });
    expect(() => parseJsonOutput('No brain configured. Run: gbrain init')).toThrow('did not print JSON');
  });

  test('parseErrorCode reads stderr and stdout forms', () => {
    const stderr = 'Error [page_not_found]: Page not found: people/nobody\nFix: Page may be soft-deleted';
    expect(parseErrorCode('', stderr)).toBe('page_not_found');
    expect(parseErrorCode('{\n  "error": "revision_conflict",\n  "message": "x"\n}', '')).toBe('revision_conflict');
    expect(parseErrorCode('', 'GBRAIN_DB_ACCESS no_url\nNo brain configured.')).toBeUndefined();
  });

  test('parsePageRead needs content and revision', () => {
    expect(parsePageRead(JSON.stringify({ content: '# A\n', revision: 'r1', slug: 'x' }))).toEqual({ content: '# A\n', revision: 'r1' });
    expect(() => parsePageRead('{"slug":"x"}')).toThrow('content/revision');
  });

  test('parseTakeRows keeps the fields Receipts reads and drops junk', () => {
    const rows = parseTakeRows(JSON.stringify([
      { row_num: 2, claim: 'B', kind: 'bet', holder: 'people/x', weight: 0.95, source: 'S', active: true, resolved_quality: 'incorrect', extra: 1 },
      { row_num: 1, claim: 'A', kind: 'take', holder: 'people/x', weight: 0.5, source: null, active: true, resolved_quality: null },
      { claim: 'no row' },
      null,
    ]));
    expect(rows).toEqual([
      { row_num: 2, claim: 'B', kind: 'bet', holder: 'people/x', weight: 0.95, source: 'S', active: true, resolved_quality: 'incorrect' },
      { row_num: 1, claim: 'A', kind: 'take', holder: 'people/x', weight: 0.5, source: null, active: true, resolved_quality: null },
    ]);
    expect(() => parseTakeRows('{"total_bets":0}')).toThrow('did not return a list');
  });

  test('findMatchingTake finds the same claim once, never a row already linked', () => {
    const c = claim({ targetDate: '2020-12-31' });
    const row = (n: number, over: Partial<TakeRow> = {}): TakeRow => ({
      row_num: n, claim: takeClaimText(c), kind: 'bet', holder: 'people/elon-musk', weight: 0.95,
      source: takesAddArgs(c)[10]!.slice('--source='.length), active: true, resolved_quality: null, ...over,
    });
    expect(findMatchingTake(c, [row(1), row(2)])?.row_num).toBe(1);
    expect(findMatchingTake(c, [row(1), row(2)], new Set([1]))?.row_num).toBe(2);
    expect(findMatchingTake(c, [row(1, { source: 'other' })])).toBeUndefined();
    expect(findMatchingTake(c, [row(1, { kind: 'take' })])).toBeUndefined();
    expect(findMatchingTake(c, [row(1, { active: false })])).toBeUndefined();
  });
});

describe('person template', () => {
  test("follows GBrain's Person template with every section as [No data yet] and no Timeline", () => {
    const page = personTemplate('Jane Doe');
    expect(page.startsWith('---\ntype: person\ntitle: Jane Doe\ntags: [receipts]\n---\n# Jane Doe\n\n> ')).toBe(true);
    for (const s of ['State', 'What They Believe', "What They're Building", 'What Motivates Them', 'Communication Style',
      'Hobby Horses', 'Assessment', 'Trajectory', 'Relationship', 'Contact', 'Network', 'Open Threads']) {
      expect(page).toContain(`## ${s}\n[No data yet]\n`);
    }
    expect(page).not.toContain('Timeline');
  });

  test('quotes YAML titles that need it', () => {
    expect(personTemplate('Björn: Ulvaeus')).toContain('title: "Björn: Ulvaeus"\n');
    expect(personTemplate("Conan O'Brien")).toContain("title: Conan O'Brien\n");
  });
});

describe('track record block', () => {
  const graded = [
    claim({ claim: 'A', verdict: 'correct', impliedProbability: 0.65, topic: 'robots' }),
    claim({ claim: 'B', verdict: 'incorrect', impliedProbability: 0.95, topic: 'robots' }),
    claim({ claim: 'C', verdict: 'partial', topic: 'cars' }),
    claim({ claim: 'D', verdict: 'pending', topic: 'cars' }),
  ];
  const block = renderTrackRecord(scorePerson(graded), ['robots: 2020-12-31 → 2022-12-31 (pushed later)']);

  test('renders the score between the markers, deterministically', () => {
    expect(block.startsWith(`${TRACK_RECORD_BEGIN}\n## Track Record\n`)).toBe(true);
    expect(block.endsWith(TRACK_RECORD_END)).toBe(true);
    expect(block).toContain('- **Accuracy:** 50% (1 of 2 resolved correct/incorrect)');
    expect(block).toContain('- **Brier:** 0.512 (coin-flip baseline 0.25; lower is better)');
    expect(block).toContain('1 correct, 1 incorrect, 1 partial, 0 unresolvable, 0 too early, 1 pending');
    expect(block).toContain('### Story drift\n- robots: 2020-12-31 → 2022-12-31 (pushed later)');
    expect(block).not.toContain('Lateness');
    expect(renderTrackRecord(scorePerson(graded), ['robots: 2020-12-31 → 2022-12-31 (pushed later)'])).toBe(block);
  });

  test('says n/a when nothing is graded', () => {
    const empty = renderTrackRecord(scorePerson([claim()]), []);
    expect(empty).toContain('**Accuracy:** n/a');
    expect(empty).toContain('**Brier:** n/a');
    expect(empty).not.toContain('Story drift');
  });

  test('inserts right after the H1 + summary and keeps every other byte, takes fence and timeline included', () => {
    const out = spliceTrackRecord(GBRAIN_PAGE, block);
    const summary = '> Public figure tracked by Receipts: a track record on public statements.\n';
    expect(out).toContain(`${summary}\n${block}\n\n## State`);
    expect(out.replace(`${block}\n\n`, '')).toBe(GBRAIN_PAGE);
    expect(fenceAndTimeline(out)).toBe(fenceAndTimeline(GBRAIN_PAGE));
    expect(out.indexOf(TRACK_RECORD_BEGIN)).toBeLessThan(out.indexOf('## Timeline'));
  });

  test('replaces an existing block in place and is idempotent', () => {
    const first = spliceTrackRecord(GBRAIN_PAGE, block);
    const newer = renderTrackRecord(scorePerson(graded.slice(0, 1)), []);
    const second = spliceTrackRecord(first, newer);
    expect(second.split(TRACK_RECORD_BEGIN)).toHaveLength(2);
    expect(second.replace(newer, block)).toBe(first);
    expect(fenceAndTimeline(second)).toBe(fenceAndTimeline(GBRAIN_PAGE));
    expect(spliceTrackRecord(second, newer)).toBe(second);
  });

  test('multi-line summaries, a missing summary, and a page with no H1 before the timeline', () => {
    const multi = '# A\n\n> one\n> two\n\n## State\n';
    expect(spliceTrackRecord(multi, 'BLOCK')).toBe('# A\n\n> one\n> two\n\nBLOCK\n\n## State\n');
    expect(spliceTrackRecord('# A\n## State\n', 'BLOCK')).toBe('# A\n\nBLOCK\n\n## State\n');
    expect(spliceTrackRecord('---\ntype: person\n---\nIntro.\n\n<!-- timeline -->\n', 'BLOCK')).toBe(
      '---\ntype: person\n---\nIntro.\n\nBLOCK\n\n<!-- timeline -->\n',
    );
    expect(spliceTrackRecord('# A\n\n> s', 'BLOCK')).toBe('# A\n\n> s\n\nBLOCK\n');
  });

  test('refuses a begin marker without an end marker', () => {
    expect(() => spliceTrackRecord(`# A\n${TRACK_RECORD_BEGIN}\nold\n## State\n`, 'BLOCK')).toThrow('no "<!-- receipts:track-record:end -->"');
  });

  test('driftChainLines lists topics with 2+ claims, deadlines in order, with drift labels', () => {
    const l = ledgerOf([
      claim({ claim: 'Mars 1', saidDate: '2016-09-27', targetDate: '2022-12-31', topic: 'mars', drift: { label: 'first', note: '' } }),
      claim({ claim: 'Mars 2', saidDate: '2019-01-01', targetDate: '2024-12-31', topic: 'mars', drift: { label: 'pushed_later', note: '' } }),
      claim({ claim: 'Mars 3', saidDate: '2021-01-01', targetDate: '2026-12-31', topic: 'mars', drift: { label: 'pushed_later', note: '' } }),
      claim({ claim: 'Solo', topic: 'solo' }),
      claim({ claim: 'Other person', personSlug: 'someone-else', topic: 'mars' }),
    ]);
    expect(driftChainLines(l, 'elon-musk')).toEqual(['mars: 2022-12-31 → 2024-12-31 → 2026-12-31 (pushed later ×2)']);
  });
});

describe('sync bookkeeping', () => {
  test('needsSync: timeline, take, then resolution for graded predictions only', () => {
    const page = 'people/elon-musk';
    expect(needsSync(claim())).toBe(true);
    expect(needsSync(claim({ gbrain: { page, timelineWritten: true } }))).toBe(true);
    expect(needsSync(claim({ gbrain: { page, timelineWritten: true, row: 1 } }))).toBe(false);
    expect(needsSync(claim({ verdict: 'too_early', gbrain: { page, timelineWritten: true, row: 1 } }))).toBe(false);
    expect(needsSync(claim({ verdict: 'correct', gbrain: { page, timelineWritten: true, row: 1 } }))).toBe(true);
    expect(needsSync(claim({ verdict: 'correct', gbrain: { page, timelineWritten: true, row: 1, resolvedQuality: 'correct' } }))).toBe(false);
    expect(needsSync(claim({ type: 'stance', verdict: 'correct', gbrain: { page, timelineWritten: true, row: 1 } }))).toBe(false);
  });

  test('a regrade that GBrain cannot take back still needs attention (to warn about)', () => {
    const page = 'people/elon-musk';
    expect(needsSync(claim({ verdict: 'correct', gbrain: { page, timelineWritten: true, row: 1, resolvedQuality: 'incorrect' } }))).toBe(true);
  });

  test('a disputed grading is never resolved in GBrain, so a regrade can still land', () => {
    const disputed = claim({
      verdict: 'unresolvable',
      grading: { verdict: 'unresolvable', confidence: 0.5, rationale: 'x', evidence: [], gradedAt: '2026-01-01T00:00:00Z', gradedBy: 'gpt-5', disputed: true },
      gbrain: { page: 'people/elon-musk', timelineWritten: true, row: 1 },
    });
    expect(resolvableQuality(disputed)).toBeNull();
    expect(needsSync(disputed)).toBe(false);
    expect(resolvableQuality({ ...disputed, grading: { ...disputed.grading!, disputed: undefined } })).toBe('unresolvable');
  });

  test('forgetBrainLinks drops the links in scope only', () => {
    const page = 'people/elon-musk';
    const l = ledgerOf([
      claim({ claim: 'a', gbrain: { page, row: 1, timelineWritten: true } }),
      makeClaim({ personSlug: 'sam-altman', person: 'Sam Altman', claim: 'b', gbrain: { page: 'people/sam-altman', row: 2 } }),
    ]);
    expect(forgetBrainLinks(l, 'elon-musk')).toBe(1);
    expect(l.claims.map((c) => c.gbrain?.row)).toEqual([undefined, 2]);
    expect(forgetBrainLinks(l)).toBe(1);
    expect(l.claims.every((c) => !c.gbrain)).toBe(true);
  });
});

describe('missing gbrain', () => {
  const gb = new GBrain({ bin: '/nonexistent/gbrain-for-receipts-tests' });

  test('available() is false instead of throwing', async () => {
    expect(await gb.available()).toBe(false);
  });

  test('commands fail with a clear, actionable error', async () => {
    const err = await gb.getPage('people/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GBrainMissingError);
    expect((err as Error).message).toContain('GBRAIN_BIN');
    const sync = await gb.syncClaims(ledgerOf([claim()])).catch((e: unknown) => e);
    expect(sync).toBeInstanceOf(GBrainMissingError);
  });
});
