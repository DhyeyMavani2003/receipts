import { describe, expect, test } from 'bun:test';

import {
  claimStamp,
  driftChip,
  esc,
  escKeepDates,
  fmtBrier,
  fmtClock,
  fmtDate,
  fmtDeadline,
  fmtMultiplier,
  fmtPct,
  latenessText,
  pageShell,
  receiptCard,
  SITE_CSS,
  safeHref,
  tallyBar,
  verdictStamp,
} from '../src/site/theme.ts';
import type { Claim, Verdict } from '../src/types.ts';
import { sampleLedger } from './site-fixtures.ts';

function claimWhere(pred: (c: Claim) => boolean): Claim {
  const c = sampleLedger().claims.find(pred);
  if (!c) throw new Error('fixture claim missing');
  return c;
}

describe('esc', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
  test('renders null and undefined as empty and numbers as text', () => {
    expect(esc(undefined)).toBe('');
    expect(esc(null)).toBe('');
    expect(esc(0.5)).toBe('0.5');
  });
  test('escKeepDates escapes first, then keeps ISO dates on one line', () => {
    expect(escKeepDates('Moved <b> from 2020-12-31')).toBe('Moved &lt;b&gt; from <span class="nw">2020-12-31</span>');
  });
});

describe('safeHref', () => {
  test('passes http(s) URLs through, escaped', () => {
    expect(safeHref('https://example.com/a?b=1&c="2"')).toBe('https://example.com/a?b=1&amp;c=&quot;2&quot;');
    expect(safeHref('http://example.com')).toBe('http://example.com');
  });
  test('rejects script, data, relative and malformed URLs', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>', '/local/path', 'fixtures/x.txt', 'https://exa mple.com', '', undefined, null]) {
      expect(safeHref(bad)).toBeNull();
    }
  });
});

describe('formatting', () => {
  test('dates and deadlines read the way people say them', () => {
    expect(fmtDate('2019-04-22')).toBe('Apr 22, 2019');
    expect(fmtDeadline('2020-12-31')).toBe('2020');
    expect(fmtDeadline('2026-03-31')).toBe('Mar 2026');
    expect(fmtDeadline('2024-02-29')).toBe('Feb 2024');
    expect(fmtDeadline('2025-02-28')).toBe('Feb 2025');
    expect(fmtDeadline('2026-03-15')).toBe('Mar 15, 2026');
    expect(fmtDeadline('someday')).toBe('someday');
  });
  test('numbers, with an em dash for missing values', () => {
    expect(fmtPct(0.375)).toBe('38%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtBrier(0.61)).toBe('0.61');
    expect(fmtBrier(null)).toBe('—');
    expect(fmtMultiplier(2.4333)).toBe('2.4×');
    expect(fmtMultiplier(null)).toBe('—');
    expect(fmtClock(3723)).toBe('1:02:03');
    expect(fmtClock(65)).toBe('1:05');
  });
});

describe('stamps', () => {
  const tones: Record<Verdict, string> = {
    correct: 'v-correct',
    incorrect: 'v-incorrect',
    partial: 'v-partial',
    unresolvable: 'v-unresolvable',
    too_early: 'v-open',
    pending: 'v-open',
  };
  test.each(Object.entries(tones))('%s gets the %s tone and a text label', (verdict, tone) => {
    const html = verdictStamp(verdict as Verdict);
    expect(html).toContain(`class="stamp ${tone}"`);
    expect(html).toContain('<span class="vh">Verdict: </span>');
  });
  test('disputed verdicts say so', () => {
    expect(verdictStamp('unresolvable', { disputed: true })).toContain('disputed');
  });
  test('ungraded stances get an on-record tag, not a PENDING stamp', () => {
    const stance = claimWhere((c) => c.type === 'stance' && c.verdict === 'pending');
    const html = claimStamp(stance);
    expect(html).toContain('class="tag"');
    expect(html).not.toContain('stamp');
  });
});

describe('tallyBar', () => {
  test('draws only non-zero segments and labels the counts', () => {
    const html = tallyBar({ correct: 2, partial: 0, incorrect: 3, unresolvable: 0, open: 1 });
    expect(html).toContain('aria-label="2 correct, 0 partial, 3 incorrect, 0 unresolvable, 1 open"');
    expect(html.match(/class="t /g)).toHaveLength(3);
    expect(html).not.toContain('t-partial');
  });
  test('an empty record is a dashed empty track', () => {
    expect(tallyBar({ correct: 0, partial: 0, incorrect: 0, unresolvable: 0, open: 0 })).toContain('tally-empty');
  });
});

describe('receiptCard', () => {
  test('shows quote, claim, deadline, hedge probability, stamp, evidence and GBrain row', () => {
    const c = claimWhere((x) => x.hedge === 'for sure');
    const html = receiptCard(c, { anchor: true });
    expect(html).toContain(`id="c-${c.id}"`);
    expect(html).toContain('“Next year for sure, we will have over a million robotaxis on the road.”');
    expect(html).toContain('Dec 31, 2020');
    expect(html).toContain('(inferred)');
    expect(html).toContain('95%');
    expect(html).toContain('stamp v-incorrect');
    expect(html).toContain('▶</span> 1:02:03');
    expect(html).toContain('href="https://www.youtube.com/watch?v=vantage0001&amp;t=3723s"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('GBrain take #1');
    expect(html).toContain('2 judges agreed');
  });
  test('correct-but-late predictions say how late', () => {
    const html = receiptCard(claimWhere((x) => x.topic === 'vantage-semi'));
    expect(html).toContain('came true 35 months late');
    expect(html).toContain('resolved Dec 2022');
  });
  test('lateness under a month is in days; a missed deadline that happened later says so too', () => {
    const base = claimWhere((x) => x.topic === 'vantage-semi');
    const at = (verdict: Claim['verdict'], targetDate: string, resolvedOn: string): Claim => ({
      ...base,
      verdict,
      targetDate,
      grading: { ...base.grading!, verdict: verdict as Exclude<Claim['verdict'], 'pending'>, resolvedOn },
    });
    expect(latenessText(at('correct', '2025-12-31', '2026-01-10'))).toBe('came true 10 days late');
    expect(latenessText(at('correct', '2025-12-31', '2026-01-01'))).toBe('came true 1 day late');
    expect(latenessText(at('incorrect', '2019-12-31', '2022-10-06'))).toBe('came true 33 months late');
    expect(latenessText(at('correct', '2025-12-31', '2025-12-01'))).toBe('');
    expect(latenessText(at('partial', '2019-12-31', '2022-10-06'))).toBe('');
  });
  test('a stance or fact shows no hedge probability; a prediction does', () => {
    const c = claimWhere((x) => x.hedge === 'for sure');
    expect(receiptCard(c)).toContain('<dt>Hedge</dt>');
    expect(receiptCard({ ...c, type: 'stance' })).not.toContain('<dt>Hedge</dt>');
  });
  test('drift chips say when a label was hand-written or model-judged', () => {
    const d = { label: 'goalposts_moved' as const, previousClaimId: 'p', note: 'Mars became the Moon.' };
    expect(driftChip(d)).not.toContain('chip-by');
    expect(driftChip({ ...d, labeledBy: 'human:seed-drift' })).toContain('<span class="chip-by">curated label</span>');
    expect(driftChip({ ...d, labeledBy: 'gpt-5' })).toContain('<span class="chip-by">model-judged</span>');
  });
  test('flags quotes that were not string-matched', () => {
    expect(receiptCard(claimWhere((x) => !x.quoteVerified))).toContain('Quote not string-matched');
  });
  test('escapes hostile text and refuses non-http links', () => {
    const c = claimWhere((x) => x.hedge === 'for sure');
    const hostile: Claim = {
      ...c,
      person: '<script>alert(1)</script>',
      quote: '"><img src=x onerror=alert(1)>',
      claim: '<b>bold</b>',
      hedge: '<i>',
      topic: 'x"y',
      source: { ...c.source, title: '<svg onload=alert(1)>', url: 'javascript:alert(1)', deepLink: 'javascript:alert(2)' },
      grading: { ...c.grading!, rationale: '</p><script>x</script>', evidence: [{ url: 'javascript:alert(3)', title: '<u>t</u>', snippet: '<q>' }] },
    };
    const html = receiptCard(hostile, { personHref: '/p/x' });
    expect(html).not.toMatch(/<script|<img|<svg|<b>|<u>|<i>/);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('pageShell', () => {
  test('is a complete document with system fonts (no network), both themes and the footer line', () => {
    const html = pageShell({ title: 'A <b>', body: '<p>hi</p>', home: '/' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>A &lt;b&gt;</title>');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
    expect(html).toContain('system-ui');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('prefers-reduced-motion: reduce');
    expect(html).toContain('Verdicts are AI-assisted; every one links its evidence.');
    expect(html).not.toContain('<script');
  });
  test('the inline script carries the CSP nonce', () => {
    expect(pageShell({ title: 't', body: '', home: '/', script: 'void 0', nonce: 'abc' })).toContain('<script nonce="abc">void 0</script>');
  });
});

describe('projector legibility', () => {
  test('leaderboard headers are at least 13px, cells at least 17px, and thin-record numbers use the darker grey', () => {
    expect(SITE_CSS).toContain('#leaderboard th{font-size:.8125rem;color:var(--ink-2)}');
    expect(SITE_CSS).toContain('#leaderboard td{font-size:1.0625rem}');
    expect(SITE_CSS).toContain('#leaderboard td.thin,#leaderboard td.thin .num-strong{color:var(--ink-2)}');
  });

  test('seed verdicts and drift labels say curated, not hand-verified', () => {
    const base = sampleLedger().claims.find((x) => x.grading)!;
    const c = { ...base, grading: { ...base.grading!, gradedBy: 'human:seed' } };
    expect(receiptCard(c)).toContain('Curated · sources linked');
    expect(receiptCard(c)).not.toContain('Hand-verified');
    expect(driftChip({ label: 'goalposts_moved', note: 'x', labeledBy: 'human:seed-drift' } as never)).toContain('curated label');
  });
});
