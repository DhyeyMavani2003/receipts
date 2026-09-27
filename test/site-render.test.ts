import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chains } from '../src/drift.ts';
import { emptyLedger } from '../src/ledger.ts';
import { scoreAll } from '../src/score.ts';
import { chainSummary, recordedQuestions, renderIndex, renderPerson, suggestedQuestions, topicLabel, withDetectedDrift, writeSite } from '../src/site/render.ts';
import type { Claim, Ledger } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';
import { sampleLedger } from './site-fixtures.ts';

const ledger = sampleLedger();
const scores = scoreAll(ledger);
const index = renderIndex(ledger, scores);
const mara = renderPerson(ledger, 'mara-quill');
const jonah = renderPerson(ledger, 'jonah-pike');

/** Visible text of the element that follows `marker`, crudely: tags stripped. */
function textAfter(html: string, marker: string, length = 400): string {
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  return html.slice(at, at + length).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('renderIndex', () => {
  test('lists every person in score order, linking to their static page', () => {
    const order = scores.map((s) => index.indexOf(`href="people/${s.personSlug}.html"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(scores.map((s) => s.personSlug)).toEqual(['mara-quill', 'theo-brandt', 'iris-calloway', 'jonah-pike']);
  });

  test('leaderboard shows predictions, accuracy, Brier against a coin flip, lateness, pending and drift', () => {
    const row = textAfter(index, 'href="people/mara-quill.html"', 1500);
    expect(row).toContain('Mara Quill');
    // 4 graded predictions is a thin record: the Brier gets no verdict against a coin flip.
    expect(row).toMatch(/7 8 claims 25% 1 of 4 0\.61 thin record 2\.4× 2 4/);
    expect(index).toContain('<td class="thin"><span class="num-strong">25%</span>');
    expect(index).toContain('<th scope="col" class="opt">Late ×</th>');
    expect(textAfter(index, 'href="people/theo-brandt.html"', 1500)).toContain('thin record');
  });

  test('from five graded predictions the Brier is compared with a coin flip', () => {
    const graded = [1, 2, 3, 4, 5].map((i) =>
      makeClaim({ claim: `Prediction ${i}.`, verdict: 'correct', grading: { verdict: 'correct', confidence: 1, rationale: 'r', evidence: [{ url: 'https://e.example' }], gradedAt: '2026-01-01T00:00:00Z', gradedBy: 'human:test' } }),
    );
    const l = ledgerOf(graded);
    const html = renderIndex(l, scoreAll(l));
    expect(html).toContain('better than coin flip');
    expect(html).not.toContain('class="thin"');
  });

  test('the live bench prefers recorded ask questions for its chips, and shows host and link fields', () => {
    const questions = recordedQuestions(['Question: How much should I trust Elon Musk on robotaxi timelines?\n\n## Elon Musk', 'no question here']);
    expect(questions).toEqual(['How much should I trust Elon Musk on robotaxi timelines?']);
    const live = renderIndex(sampleLedger(), scoreAll(sampleLedger()), { live: true, nonce: 'n', questions });
    expect(live).toContain('data-q="How much should I trust Elon Musk on robotaxi timelines?"');
    expect(live).toContain('id="f-host"');
    expect(live).not.toContain('More options');
  });

  test('a person with zero predictions still gets a row with dashes', () => {
    const row = textAfter(index, 'href="people/jonah-pike.html"', 1200);
    expect(row).toMatch(/Jonah Pike\s+0 3 claims — — —/);
    expect(index).toContain('tally-empty');
  });

  test('moving deadlines shows the robotaxi chain as dated pills in order', () => {
    const moving = index.slice(index.indexOf('id="moving"'), index.indexOf('id="latest"'));
    const robotaxi = moving.slice(moving.indexOf('vantage-robotaxi'));
    const dues = [...robotaxi.matchAll(/class="pill-due">([^<]+)</g)].slice(0, 4).map((m) => m[1]);
    expect(dues).toEqual(['2020', '2022', '2024', '2026']);
    expect(robotaxi).toContain('Deadline pushed later 3 times, 2020 → 2026.');
    expect(moving).toContain('Goalposts moved');
    expect(moving).toContain('Target changed from two cargo ships on Mars to a crewed base on the Moon.');
  });

  test('latest receipts are the newest statements first', () => {
    const latest = index.slice(index.indexOf('id="latest"'), index.indexOf('id="method"'));
    const said = [...latest.matchAll(/class="r-src"><span>[^<]*<\/span> · <time datetime="(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]!);
    expect(said).toHaveLength(6);
    expect(said).toEqual([...said].sort().reverse());
    expect(said[0]).toBe('2025-06-03');
  });

  test('the method section carries the hedge table legend', () => {
    expect(index).toContain('How the numbers work');
    expect(index).toContain('“for sure”');
    expect(index).toContain('“never going to”');
  });

  test('static pages have no script and no live tools', () => {
    expect(index).not.toContain('<script');
    expect(index).not.toContain('ingest-form');
  });

  test('live pages add the ingest form, ask box and nonce script, with /p/ links', () => {
    const live = renderIndex(ledger, scores, { live: true, nonce: 'n0nce' });
    expect(live).toContain('<form id="ingest-form"');
    expect(live).toContain('name="speaker"');
    expect(live).toContain('<form id="ask-form"');
    expect(live).toContain('<script nonce="n0nce">');
    expect(live).toContain("fetch('/api/ingest'");
    expect(live).toContain('getReader()');
    expect(live).toContain('href="/p/mara-quill"');
    expect(live).not.toContain('people/mara-quill.html');
    expect(live).toContain('data-q="How much should I trust Mara Quill on Vantage robotaxi?"');
  });

  test('an empty ledger renders empty states instead of tables', () => {
    const html = renderIndex(emptyLedger(), []);
    expect(html).toContain('The ledger is empty.');
    expect(html).toContain('No deadline has moved yet.');
    expect(html).toContain('No receipts yet.');
    expect(html).not.toContain('<table>\n<caption class="vh">Track record per person');
    expect(renderIndex(emptyLedger(), [], { live: true })).toContain('Ingest an episode above');
  });
});

describe('renderPerson', () => {
  test('tiles: accuracy, Brier with coin-flip baseline, lateness and predictions', () => {
    expect(textAfter(mara, 'class="tiles"', 900)).toMatch(/Accuracy 25% 1 of 4 decided predictions came true, plus 1 partly\./);
    expect(mara).toContain('<p class="tile-value">0.61</p>');
    expect(mara).toContain('Worse than a coin flip.');
    expect(mara).toContain('class="meter-base" style="left:25.0%"');
    expect(mara).toContain('<p class="tile-value">2.4×</p>');
    expect(mara).toContain('<p class="tile-value">7</p>');
  });

  test('per-topic and calibration tables', () => {
    expect(textAfter(mara, 'Predictions by topic', 1200)).toMatch(/vantage-robotaxi 4 0 2 1 0%/);
    expect(textAfter(mara, '<h3>Calibration</h3>', 800)).toMatch(/80%–90% 85% 50% 2/);
  });

  test('drift chains link each pill to its receipt card', () => {
    const drift = mara.slice(mara.indexOf('id="drift"'), mara.indexOf('id="receipts"'));
    const pills = [...drift.matchAll(/class="pill [^"]+" href="mara-quill\.html#c-([0-9a-f]{12})"/g)].map((m) => m[1]!);
    expect(pills).toHaveLength(6);
    for (const id of pills) expect(mara).toContain(`id="c-${id}"`);
  });

  test('receipts run oldest first, grouped by year', () => {
    const years = [...mara.matchAll(/<h3 class="year-label">(\d{4})<\/h3>/g)].map((m) => m[1]);
    expect(years).toEqual(['2017', '2019', '2021', '2023', '2024', '2025']);
    expect(mara.match(/<article class="receipt /g)).toHaveLength(8);
  });

  test('every verdict kind gets its stamp somewhere on the person pages', () => {
    const all = scores.map((s) => renderPerson(ledger, s.personSlug)).join('');
    for (const label of ['Correct', 'Incorrect', 'Partial', 'Unresolvable', 'Too early', 'Pending']) {
      expect(all).toContain(`<span class="vh">Verdict: </span>${label}`);
    }
    expect(all).toContain('disputed');
  });

  test('a person with zero predictions', () => {
    expect(jonah).toContain('No predictions on record yet: 3 stances and factual claims only.');
    expect(jonah).toContain('<p class="tile-value">—</p>');
    expect(jonah).toContain('No predictions yet.');
    expect(jonah).toContain('Reversed');
    expect(jonah).toContain('Stance · on record');
    expect(jonah).not.toContain('Verdict: </span>Pending');
  });

  test('static person pages link back to ../index.html', () => {
    expect(mara).toContain('href="../index.html"');
    expect(renderPerson(ledger, 'mara-quill', { live: true })).toContain('<a href="/">← All people</a>');
  });

  test('an unknown person renders a not-found page', () => {
    const html = renderPerson(ledger, 'nobody');
    expect(html).toContain('No receipt here.');
    expect(html).toContain('No receipts on file for “nobody”.');
  });
});

describe('escaping', () => {
  test('hostile names, quotes, titles and links never reach the page as markup', () => {
    const base = ledger.claims[0]!;
    const evil: Claim = {
      ...base,
      id: 'deadbeef0000',
      person: '<script>alert("name")</script>',
      personSlug: 'evil"><script>',
      quote: '</blockquote><img src=x onerror=alert(1)>',
      claim: '<iframe src=//x>',
      topic: '<style>*{}</style>',
      source: { ...base.source, title: '<svg/onload=alert(1)>', url: 'javascript:alert(1)' },
      drift: { label: 'goalposts_moved', note: '<marquee>note</marquee>' },
    };
    const l: Ledger = { ...ledger, claims: [...ledger.claims, evil] };
    const pages = [renderIndex(l, scoreAll(l)), renderIndex(l, scoreAll(l), { live: true }), renderPerson(l, evil.personSlug)];
    for (const html of pages) {
      expect(html).not.toMatch(/<script>alert|<img src=x|<iframe|<svg\/onload|<marquee|<style>\*/);
      expect(html).not.toContain('href="javascript:');
    }
    expect(pages[2]).toContain('&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;');
  });
});

describe('helpers', () => {
  test('chainSummary describes slips and moved goalposts in one sentence', () => {
    const summaries = chains(ledger).filter((c) => c.claims.length > 1).map(chainSummary);
    expect(summaries).toContain('2022 → 2027, goalposts moved once. 2 claims, Sep 2017 to Feb 2024.');
    expect(summaries).toContain('Reversed once. 2 claims, Jun 2021 to Jan 2025.');
  });

  test('withDetectedDrift fills only missing labels', () => {
    const bare: Ledger = { ...ledger, claims: ledger.claims.map(({ drift: _drift, ...c }) => c as Claim) };
    const filled = withDetectedDrift(bare);
    expect(filled.claims.every((c) => c.drift)).toBe(true);
    expect(withDetectedDrift(ledger)).toBe(ledger);
  });

  test('topicLabel title-cases topic slugs for starter chips, keeping names and acronyms', () => {
    expect(topicLabel('tesla-robotaxi')).toBe('Tesla robotaxi');
    expect(topicLabel('ai-coding')).toBe('AI coding');
    expect(topicLabel('iphone-launch')).toBe('iPhone launch');
    expect(topicLabel('mars-landing')).toBe('Mars landing');
    expect(topicLabel('car-ownership')).toBe('Car ownership');
  });

  test('suggestedQuestions uses the busiest people and their main topic', () => {
    expect(suggestedQuestions(scores)).toEqual([
      'How much should I trust Mara Quill on Vantage robotaxi?',
      'How much should I trust Theo Brandt on AI coding?',
    ]);
    expect(suggestedQuestions([])).toEqual([]);
  });
});

describe('writeSite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-site-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('writes index.html plus one page per person, and every link resolves', () => {
    const paths = writeSite(ledger, dir);
    expect(paths).toEqual([
      join(dir, 'index.html'),
      ...['mara-quill', 'theo-brandt', 'iris-calloway', 'jonah-pike'].map((s) => join(dir, 'people', `${s}.html`)),
    ]);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    for (const [, href] of html.matchAll(/href="(people\/[^"#]+)/g)) expect(existsSync(join(dir, href!))).toBe(true);
  });

  test('pages render deterministic drift even when the ledger has none stored', () => {
    const bare: Ledger = { ...ledger, claims: ledger.claims.map(({ drift: _drift, ...c }) => c as Claim) };
    writeSite(bare, dir);
    expect(readFileSync(join(dir, 'people', 'mara-quill.html'), 'utf8')).toContain('Deadline pushed');
  });
});
