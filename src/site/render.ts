// Pages. The same renderers serve the static site (writeSite: index.html +
// people/<slug>.html with relative links) and the live server (absolute
// /p/<slug> links, plus the ingest and ask tools on the index page).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chains, detectDrift } from '../drift.ts';
import type { DriftChain } from '../drift.ts';
import { HEDGE_TABLE } from '../hedge.ts';
import { claimsFor, slugify } from '../ledger.ts';
import { scoreAll, scorePerson } from '../score.ts';
import type { Claim, DriftLabel, Ledger, PersonScore } from '../types.ts';
import {
  DRIFT_LABEL_TEXT,
  NOTABLE_DRIFT,
  TYPE_LABEL,
  VERDICT_LABEL,
  claimStamp,
  driftLabeledByText,
  esc,
  escKeepDates,
  fmtBrier,
  fmtDate,
  fmtDeadline,
  fmtMonth,
  fmtMultiplier,
  fmtPct,
  pageShell,
  plural,
  receiptCard,
  tallyBar,
  tallyLegend,
  verdictTone,
} from './theme.ts';
import type { Tally } from './theme.ts';

export interface RenderOptions {
  /** Live server pages: absolute links, and the ingest + ask tools on the index. */
  live?: boolean;
  /** CSP nonce for the live page's inline script. */
  nonce?: string;
  /** Starter questions for the ask box (recorded ones, so they replay offline); defaults to suggestedQuestions(). */
  questions?: string[];
}

/** Brier score of always saying 50%: the baseline every tile compares against. */
export const COIN_FLIP_BRIER = 0.25;
const LATEST_COUNT = 6;
const MOVING_COUNT = 4;
const JUDGMENT_LABELS = new Set<DriftLabel>(['goalposts_moved', 'reversed', 'escalated', 'softened']);

// ---- Links ------------------------------------------------------------------

interface Links {
  home: string;
  person(slug: string): string;
}

/** File-system-safe slug for people/<slug>.html; ledger slugs are normally already safe. */
export function fileSlug(personSlug: string): string {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(personSlug) ? personSlug : slugify(personSlug) || 'unnamed';
}

function linksFor(page: 'index' | 'person', live: boolean): Links {
  if (live) return { home: '/', person: (slug) => `/p/${encodeURIComponent(slug)}` };
  if (page === 'index') return { home: 'index.html', person: (slug) => `people/${fileSlug(slug)}.html` };
  return { home: '../index.html', person: (slug) => `${fileSlug(slug)}.html` };
}

// ---- Data helpers -------------------------------------------------------------

/** Claims without a stored drift label get the deterministic one, so chains and chips render before `receipts drift` has run. */
export function withDetectedDrift(l: Ledger): Ledger {
  if (l.claims.every((c) => c.drift)) return l;
  const det = detectDrift(l);
  return { ...l, claims: l.claims.map((c) => (c.drift ? c : { ...c, drift: det.get(c.id) })) };
}

export function tallyOf(s: PersonScore): Tally {
  return { correct: s.correct, partial: s.partial, incorrect: s.incorrect, unresolvable: s.unresolvable, open: s.pending + s.tooEarly };
}

function notableCount(chain: DriftChain): number {
  return chain.claims.filter((c) => c.drift && NOTABLE_DRIFT.has(c.drift.label)).length;
}

function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/** One deterministic sentence about how a chain moved. */
export function chainSummary(chain: DriftChain): string {
  const count = (label: DriftLabel) => chain.claims.filter((c) => c.drift?.label === label).length;
  const parts: string[] = [];
  const pushed = count('pushed_later');
  const dated = chain.claims.filter((c) => c.targetDate);
  if (pushed) parts.push(`Deadline pushed later ${times(pushed)}`);
  if (dated.length >= 2) {
    const first = fmtDeadline(dated[0]!.targetDate!);
    const last = fmtDeadline(dated[dated.length - 1]!.targetDate!);
    if (first !== last) parts.push(`${first} → ${last}`);
  }
  const moved = count('goalposts_moved');
  if (moved) parts.push(`goalposts moved ${times(moved)}`);
  const reversed = count('reversed');
  if (reversed) parts.push(`reversed ${times(reversed)}`);
  const said = `${plural(chain.claims.length, 'claim')}, ${fmtMonth(chain.claims[0]!.saidDate)} to ${fmtMonth(chain.claims.at(-1)!.saidDate)}`;
  if (!parts.length) return said;
  const sentence = parts.join(', ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. ${said}.`;
}

function movingChains(l: Ledger, personSlug?: string): DriftChain[] {
  return chains(l)
    .filter((ch) => ch.claims.length >= 2 && (personSlug === undefined || ch.personSlug === personSlug))
    .sort((a, b) => notableCount(b) - notableCount(a) || b.claims.length - a.claims.length || a.topic.localeCompare(b.topic));
}

// ---- Shared blocks ------------------------------------------------------------

/** Section title bar. `note` is trusted HTML (callers pass literals). */
function sectionHead(title: string, note = '', headingId?: string): string {
  const id = headingId ? ` id="${headingId}"` : '';
  return `<div class="sec-head"><h2${id}>${esc(title)}</h2>${note ? `<p>${note}</p>` : ''}</div>`;
}

function pill(c: Claim, href: string): string {
  const due = c.targetDate
    ? `<span class="pill-due">${esc(fmtDeadline(c.targetDate))}</span>`
    : '<span class="pill-due nodate">No deadline</span>';
  const status = c.type !== 'prediction' && c.verdict === 'pending' ? TYPE_LABEL[c.type] : VERDICT_LABEL[c.verdict];
  const label = c.drift && c.drift.label !== 'first' ? c.drift.label : undefined;
  const chip = label ? `<span class="chip${NOTABLE_DRIFT.has(label) ? ' chip-notable' : ''}">${esc(DRIFT_LABEL_TEXT[label])}</span>` : '';
  const note = label && JUDGMENT_LABELS.has(label) ? `<span class="pill-note">${escKeepDates(c.drift!.note)}</span>` : '';
  const by = label && JUDGMENT_LABELS.has(label) ? driftLabeledByText(c.drift!) : '';
  const byTag = by ? `<span class="pill-by">${esc(by)}</span>` : '';
  const title = c.drift?.note ?? c.claim;
  return `<li class="step"><a class="pill ${verdictTone(c.verdict)}" href="${esc(href)}" title="${esc(title)}">
<span class="pill-said">Said <time datetime="${esc(c.saidDate)}">${esc(fmtMonth(c.saidDate))}</time></span>${due}<span class="pill-v">${esc(status)}</span>${chip}${byTag}${note}</a></li>`;
}

function chainCard(chain: DriftChain, links: Links, showPerson: boolean, plainTopic = false): string {
  const topic = plainTopic ? topicLabel(chain.topic) : chain.topic;
  const personHref = links.person(chain.personSlug);
  const name = chain.claims[0]!.person;
  const heading = showPerson
    ? `<a href="${esc(personHref)}">${esc(name)}</a> <span class="muted">/</span> ${esc(topic)}`
    : esc(topic);
  const steps = chain.claims.map((c) => pill(c, `${personHref}#c-${c.id}`)).join('');
  return `<article class="chain">
<div class="chain-head"><h3>${heading}</h3><p class="chain-sum">${esc(chainSummary(chain))}</p></div>
<ol class="steps" aria-label="Claims on ${esc(chain.topic)}, oldest first">${steps}</ol>
</article>`;
}

function methodSection(): string {
  const rows = HEDGE_TABLE.map((r) => {
    const words = r.phrases.map((p) => `“${esc(p)}”`).join(', ');
    return `<tr><td>${fmtPct(r.p)}</td><td>${words}${r.note ? ` <span class="muted">(${esc(r.note)})</span>` : ''}</td></tr>`;
  }).join('');
  return `<section class="sec" id="method" aria-labelledby="method-h">
${sectionHead('How the numbers work', '', 'method-h')}
<div class="method">
<dl>
<dt>Only verbatim quotes</dt><dd>Every claim is published with the speaker's exact words and a link to the source. Extracted quotes must string-match the transcript or they are dropped.</dd>
<dt>Accuracy</dt><dd>Correct ÷ (correct + incorrect) over graded predictions, the same rule as GBrain's <code>takes scorecard</code>. Partial and unresolvable outcomes are shown but not counted.</dd>
<dt>Brier score</dt><dd>The mean squared gap between how sure the speaker sounded and what happened. 0 is perfect; always saying 50% scores 0.25, so anything above 0.25 is worse than a coin flip.</dd>
<dt>Late ×</dt><dd>For predictions that came true after their deadline (graded incorrect, since the deadline passed first): how many times the promised time it actually took (median). 2.0× means twice as long as promised.</dd>
<dt>Drift</dt><dd>Claims on the same topic are chained over time. A deadline that moves by 60 days or more is measured in code; a model labels changes to the claim itself, such as moved goalposts or a reversal.</dd>
</dl>
<div>
<h3 class="vh">Hedge words and implied probability</h3>
<div class="table-wrap"><table class="hedge-table">
<caption class="vh">How sure the speaker sounded: hedge words and the probability they imply</caption>
<thead><tr><th scope="col">Implied</th><th scope="col">Hedge words used</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<p class="note">Probabilities come from the speaker's own hedge words by this fixed table, never from a model, so scores cannot be nudged after the fact.</p>
</div>
</div>
</section>`;
}

// ---- Index ------------------------------------------------------------------

function statsTape(l: Ledger, scores: PersonScore[]): string {
  const graded = scores.reduce((n, s) => n + s.correct + s.incorrect + s.partial + s.unresolvable, 0);
  const open = scores.reduce((n, s) => n + s.pending + s.tooEarly, 0);
  const drift = scores.reduce((n, s) => n + s.driftEvents, 0);
  const items: [string, number][] = [
    ['People', scores.length],
    ['Claims', l.claims.length],
    ['Graded', graded],
    ['Open', open],
    ['Drift events', drift],
  ];
  return `<dl class="tape" id="stats">${items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

/** Fewer graded predictions than this is a thin record: the numbers are shown greyed, without a verdict on them. */
export const THIN_RECORD = 5;

function brierCell(b: number | null, thin: boolean): string {
  if (b === null) return '<td>—</td>';
  if (thin) return `<td class="thin">${fmtBrier(b)}<span class="sub">thin record</span></td>`;
  const cmp = b < COIN_FLIP_BRIER ? ['better', 'better than coin flip'] : b > COIN_FLIP_BRIER ? ['worse', 'worse than coin flip'] : ['', 'same as coin flip'];
  return `<td>${fmtBrier(b)}<span class="sub ${cmp[0]}">${cmp[1]}</span></td>`;
}

function leaderboardRow(s: PersonScore, links: Links): string {
  const decided = s.correct + s.incorrect;
  const thin = decided < THIN_RECORD;
  const acc = s.accuracy === null ? '<td>—</td>' : `<td${thin ? ' class="thin"' : ''}><span class="num-strong">${fmtPct(s.accuracy)}</span><span class="sub">${s.correct} of ${decided}</span></td>`;
  return `<tr>
<th scope="row" class="who-cell"><a class="who" href="${esc(links.person(s.personSlug))}">${esc(s.person)}</a>${tallyBar(tallyOf(s))}</th>
<td><span class="num-strong">${s.predictions}</span><span class="sub opt">${plural(s.claims, 'claim')}</span></td>
${acc}
${brierCell(s.brier, thin)}
<td class="opt">${fmtMultiplier(s.latenessMultiplier)}</td>
<td class="opt">${s.pending + s.tooEarly}</td>
<td class="opt">${s.driftEvents}</td>
</tr>`;
}

function leaderboard(scores: PersonScore[], links: Links, live: boolean): string {
  const head = sectionHead('Leaderboard', 'Everyone with receipts on file, most predictions first.', 'lb-h');
  if (!scores.length) {
    const how = live
      ? 'Ingest an episode above, or run <code>receipts seed</code> to load the curated starter set (every row links its source).'
      : 'Run <code>receipts seed</code> or <code>receipts ingest &lt;url&gt; --speaker "Name"</code>, then rebuild the site.';
    return `<section class="sec" id="leaderboard">${head}<div class="empty"><strong>The ledger is empty.</strong> ${how}</div></section>`;
  }
  return `<section class="sec" id="leaderboard" aria-labelledby="lb-h">
${head}
<div class="table-wrap"><table>
<caption class="vh">Track record per person</caption>
<thead><tr><th scope="col">Person</th><th scope="col">Predictions</th><th scope="col">Accuracy</th><th scope="col">Brier</th><th scope="col" class="opt">Late ×</th><th scope="col" class="opt">Pending</th><th scope="col" class="opt">Drift</th></tr></thead>
<tbody>${scores.map((s) => leaderboardRow(s, links)).join('')}</tbody>
</table></div>
${tallyLegend()}
<p class="note">Accuracy counts correct against incorrect predictions only. Brier: 0 is perfect and a coin flip scores 0.25, so lower is better. Greyed numbers rest on fewer than ${THIN_RECORD} graded predictions. Late × is how many times the promised time a prediction took when it came true after its deadline (it still counts as incorrect). Pending includes predictions whose deadline has not arrived. Drift counts pushed deadlines, moved goalposts and reversals.</p>
</section>`;
}

function movingSection(l: Ledger, links: Links): string {
  const list = movingChains(l).filter((ch) => notableCount(ch) > 0).slice(0, MOVING_COUNT);
  const head = sectionHead('Moving deadlines', 'The same promise, restated over the years. Each pill is one statement and the deadline it gave.');
  const body = list.length
    ? `<div class="chains">${list.map((ch) => chainCard(ch, links, true)).join('')}</div>`
    : '<div class="empty">No deadline has moved yet. When someone restates a prediction with a new date, the chain shows up here.</div>';
  return `<section class="sec" id="moving">${head}${body}</section>`;
}

function latestSection(l: Ledger, links: Links): string {
  const latest = [...l.claims]
    .sort((a, b) => b.saidDate.localeCompare(a.saidDate) || a.id.localeCompare(b.id))
    .slice(0, LATEST_COUNT);
  const head = sectionHead('Latest receipts', 'The most recent statements on file, newest first.');
  const body = latest.length
    ? `<div class="feed">${latest.map((c) => receiptCard(c, { personHref: links.person(c.personSlug) })).join('')}</div>`
    : '<div class="empty">No receipts yet.</div>';
  return `<section class="sec" id="latest">${head}${body}</section>`;
}

// Words a topic slug lowercases that read wrong on screen ("ai coding" -> "AI coding").
const TOPIC_WORDS: Record<string, string> = {
  ai: 'AI', agi: 'AGI', openai: 'OpenAI', iphone: 'iPhone', html5: 'HTML5', spacex: 'SpaceX', xai: 'xAI', fsd: 'FSD', ev: 'EV',
  tesla: 'Tesla', lyft: 'Lyft', mars: 'Mars', meta: 'Meta', optimus: 'Optimus', starlink: 'Starlink', flash: 'Flash',
};

/** "tesla-robotaxi" -> "Tesla robotaxi", "ai-coding" -> "AI coding": first letter up, known names and acronyms kept. */
export function topicLabel(slug: string): string {
  const ws = slug.split('-').filter(Boolean).map((w) => TOPIC_WORDS[w] ?? w);
  if (ws[0] && !TOPIC_WORDS[slug.split('-').filter(Boolean)[0]!]) ws[0] = ws[0].charAt(0).toUpperCase() + ws[0].slice(1);
  return ws.join(' ');
}

/** Two starter questions for the ask box, from the people with the most predictions. */
export function suggestedQuestions(scores: PersonScore[]): string[] {
  return scores
    .filter((s) => s.predictions > 0)
    .slice(0, 2)
    .map((s) => {
      const slug = s.byTopic[0]?.topic;
      const topic = slug ? topicLabel(slug) : '';
      return topic ? `How much should I trust ${s.person} on ${topic}?` : `How much should I trust ${s.person}?`;
    });
}

/** The question lines of recorded ask prompts ("Question: …" is their first line). */
export function recordedQuestions(excerpts: readonly string[]): string[] {
  return [...new Set(excerpts.flatMap((e) => /^Question: (.+)$/m.exec(e)?.[1]?.trim() ?? []))];
}

function liveBench(scores: PersonScore[], questions?: string[]): string {
  const suggestions = (questions?.length ? questions.slice(0, 3) : suggestedQuestions(scores))
    .map((q) => `<button type="button" class="btn btn-quiet" data-q="${esc(q)}">${esc(q)}</button>`)
    .join('');
  return `<section class="bench" aria-label="Live tools">
<div class="panel" id="ingest">
<h2>Ingest an episode</h2>
<p class="hint">Paste a YouTube or web URL, or the path to a local transcript or audio file (plus its public link). Receipts keeps only claims whose quote it finds in the transcript (numbers and negations intact), then grades the ones whose deadline has passed. A relative path is read from the folder the server was started in.</p>
<form id="ingest-form" novalidate>
<div class="fields">
<div class="field wide"><label for="f-input">Episode URL or file path</label><input id="f-input" name="input" type="text" required autocomplete="off" spellcheck="false" placeholder="https://www.youtube.com/watch?v=… or ./episode.vtt"></div>
<div class="field"><label for="f-speaker">Speaker</label><input id="f-speaker" name="speaker" type="text" required autocomplete="off" placeholder="Full name"></div>
<div class="field"><label for="f-date">Date said <span>optional</span></label><input id="f-date" name="date" type="date"></div>
<div class="field"><label for="f-host">Host <span>for interviews</span></label><input id="f-host" name="host" type="text" autocomplete="off" placeholder="Interviewer's name"></div>
<div class="field wide"><label for="f-title">Title <span>optional</span></label><input id="f-title" name="title" type="text" autocomplete="off" placeholder="Episode or article title"></div>
<div class="field wide"><label for="f-url">Source link <span>needed for local files</span></label><input id="f-url" name="url" type="text" autocomplete="off" spellcheck="false" placeholder="https://…"></div>
</div>
<div class="actions"><button class="btn" type="submit" id="ingest-btn">Ingest episode</button><span class="status" id="ingest-status" role="status"></span></div>
</form>
<div class="notice notice-error" id="ingest-error" role="alert" hidden></div>
<ol class="log" id="ingest-log" aria-label="Ingest progress" hidden></ol>
</div>
<div class="panel" id="ask">
<h2>Ask the ledger</h2>
<p class="hint">“How much should I trust X on Y?” Answers cite dated receipts and say how sure they are.</p>
<form id="ask-form" role="search"><label class="vh" for="q">Question</label>
<div class="ask-row"><input id="q" name="q" type="search" required maxlength="500" autocomplete="off" placeholder="How much should I trust … on …?"><button class="btn" type="submit" id="ask-btn">Ask</button></div>
</form>
${suggestions ? `<div class="suggest">${suggestions}</div>` : ''}
<div class="notice notice-error" id="ask-error" role="alert" hidden></div>
<div class="answer" id="ask-answer" aria-live="polite"></div>
</div>
</section>
<section class="sec" id="live-feed" hidden>
${sectionHead('Fresh receipts', 'Verified quotes from this ingest, as they are checked. Stamps land when grading finishes.')}
<div class="feed" id="new-receipts" aria-live="polite"></div>
</section>`;
}

export function renderIndex(l: Ledger, scores: PersonScore[], opts: RenderOptions = {}): string {
  const live = opts.live ?? false;
  const links = linksFor('index', live);
  const ledger = withDetectedDrift(l);
  const body = `<section class="hero">
<p class="eyebrow">Ledger of public predictions</p>
<h1>What they said, word for word, and how it turned out.</h1>
<p class="lede">Receipts turns podcasts, interviews and posts into dated, verbatim claims, then grades each prediction against independent evidence when its deadline passes. <em>Intelligence you own: every episode you feed it makes your judgment sharper.</em></p>
${statsTape(ledger, scores)}
</section>
${live ? liveBench(scores, opts.questions) : ''}
${leaderboard(scores, links, live)}
${movingSection(ledger, links)}
${latestSection(ledger, links)}
${methodSection()}`;
  return pageShell({
    title: 'Receipts: track records on public statements',
    description: 'Dated, verbatim-quoted predictions by public figures, graded against independent evidence.',
    home: links.home,
    nav: [
      { href: '#leaderboard', label: 'Leaderboard' },
      { href: '#moving', label: 'Moving deadlines' },
      { href: '#method', label: 'Method' },
    ],
    body,
    script: live ? LIVE_SCRIPT : undefined,
    nonce: opts.nonce,
    updated: l.claims.length ? l.updatedAt : undefined,
  });
}

// ---- Person -------------------------------------------------------------------

function tile(label: string, value: string, sub: string, extra = ''): string {
  return `<div class="tile"><p class="tile-label">${esc(label)}</p><p class="tile-value">${value}</p><p class="tile-sub">${sub}</p>${extra}</div>`;
}

function brierMeter(b: number): string {
  const pos = (x: number) => `${(Math.min(1, Math.max(0, x)) * 100).toFixed(1)}%`;
  return `<div class="meter" role="img" aria-label="Brier ${fmtBrier(b)} on a scale from 0 (perfect) to 1; a coin flip scores 0.25">
<span class="meter-track"></span><span class="meter-base" style="left:${pos(COIN_FLIP_BRIER)}"></span><span class="meter-dot" style="left:${pos(b)}"></span></div>
<div class="meter-scale" aria-hidden="true"><span>0 perfect</span><span>0.25 coin flip</span><span>1</span></div>`;
}

function tiles(s: PersonScore): string {
  const decided = s.correct + s.incorrect;
  const accuracy =
    s.accuracy === null
      ? tile('Accuracy', '—', 'No prediction graded correct or incorrect yet.', `${tallyBar(tallyOf(s))}${tallyLegend(tallyOf(s))}`)
      : tile(
          'Accuracy',
          fmtPct(s.accuracy),
          `${s.correct} of ${decided} decided predictions came true${s.partial ? `, plus ${s.partial} partly` : ''}.`,
          `${tallyBar(tallyOf(s))}${tallyLegend(tallyOf(s))}`,
        );
  const brierWord =
    s.brier === null ? '' : s.brier < COIN_FLIP_BRIER ? 'Better than a coin flip.' : s.brier > COIN_FLIP_BRIER ? 'Worse than a coin flip.' : 'Same as a coin flip.';
  const brier =
    s.brier === null
      ? tile('Brier score', '—', 'Needs a prediction graded correct or incorrect. Lower is better; a coin flip scores 0.25.')
      : tile('Brier score', fmtBrier(s.brier), `${brierWord} Lower is better.`, brierMeter(s.brier));
  const late =
    s.latenessMultiplier === null
      ? tile('Late ×', '—', 'No prediction on record came true after its deadline.')
      : tile('Late ×', fmtMultiplier(s.latenessMultiplier), 'Median time predictions that came true late took, as a multiple of the time promised.');
  const open = s.pending + s.tooEarly;
  const preds =
    s.predictions === 0
      ? tile('Predictions', '0', `No predictions on record yet: ${plural(s.claims, 'stance or factual claim', 'stances and factual claims')} only.`)
      : tile('Predictions', String(s.predictions), `${plural(s.claims, 'claim')} on record in total; ${open} still open.`);
  return `<section class="tiles" aria-label="Track record">${accuracy}${brier}${late}${preds}</section>`;
}

function topicTable(s: PersonScore): string {
  if (!s.byTopic.length) return '<h3>Predictions by topic</h3><div class="empty">No predictions yet.</div>';
  const rows = s.byTopic
    .map(
      (t) =>
        `<tr><th scope="row"><span class="topic">${esc(t.topic)}</span></th><td>${t.predictions}</td><td>${t.correct}</td><td>${t.incorrect}</td><td>${t.partial}</td><td>${fmtPct(t.accuracy)}</td></tr>`,
    )
    .join('');
  return `<h3>Predictions by topic</h3><div class="table-wrap"><table>
<thead><tr><th scope="col">Topic</th><th scope="col">Predictions</th><th scope="col">Correct</th><th scope="col">Incorrect</th><th scope="col">Partial</th><th scope="col">Accuracy</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

function calibrationTable(s: PersonScore): string {
  if (!s.calibration.length) return '<h3>Calibration</h3><div class="empty">Needs predictions graded correct or incorrect.</div>';
  const rows = s.calibration
    .map((b) => {
      const [lo, hi] = b.bucket.split('-').map(Number);
      return `<tr><th scope="row">${fmtPct(lo)}–${fmtPct(hi)}</th><td>${fmtPct(b.predicted)}</td><td>${fmtPct(b.observed)}</td><td>${b.n}</td></tr>`;
    })
    .join('');
  return `<h3>Calibration</h3><div class="table-wrap"><table>
<thead><tr><th scope="col">Sounded</th><th scope="col">Said</th><th scope="col">Happened</th><th scope="col">n</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<p class="note">When they sounded this sure, how often it came true.</p>`;
}

function timeline(claims: Claim[]): string {
  const years = new Map<string, Claim[]>();
  for (const c of claims) {
    const y = c.saidDate.slice(0, 4);
    years.set(y, [...(years.get(y) ?? []), c]);
  }
  return `<ol class="timeline">${[...years]
    .map(
      ([year, cs]) =>
        `<li class="year"><h3 class="year-label">${esc(year)}</h3><ol class="cards">${cs.map((c) => `<li>${receiptCard(c, { anchor: true })}</li>`).join('')}</ol></li>`,
    )
    .join('')}</ol>`;
}

function personLede(claims: Claim[], s: PersonScore, slug: string): string {
  const sources = new Set(claims.map((c) => c.source.url || c.source.title)).size;
  const first = claims[0]!.saidDate.slice(0, 4);
  const last = claims.at(-1)!.saidDate.slice(0, 4);
  const span = first === last ? first : `${first} to ${last}`;
  return `${plural(claims.length, 'claim')} (${plural(s.predictions, 'prediction')}) from ${plural(sources, 'source')}, ${span}. GBrain page <code>people/${esc(slug)}</code>.`;
}

export function renderPerson(l: Ledger, personSlug: string, opts: RenderOptions = {}): string {
  const links = linksFor('person', opts.live ?? false);
  const ledger = withDetectedDrift(l);
  const claims = claimsFor(ledger, personSlug);
  if (!claims.length) return renderNotFound(`No receipts on file for “${personSlug}”.`, opts);
  const s = scorePerson(claims);
  const personChains = movingChains(ledger, personSlug);
  const chainBody = personChains.length
    ? `<div class="chains">${personChains.map((ch) => chainCard(ch, links, false)).join('')}</div>`
    : '<div class="empty">No topic has more than one claim yet, so there is nothing to compare over time.</div>';
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="${esc(links.home)}">← All people</a></nav>
<header class="person-head">
<p class="eyebrow">Track record on public statements</p>
<h1>${esc(s.person)}</h1>
<p class="lede">${personLede(claims, s, personSlug)}</p>
</header>
${tiles(s)}
<section class="sec split" aria-label="Breakdown"><div>${topicTable(s)}</div><div>${calibrationTable(s)}</div></section>
<section class="sec" id="drift">${sectionHead('How the story moved', 'Claims on the same topic, oldest first, with the deadline each one gave.')}${chainBody}</section>
<section class="sec" id="receipts">${sectionHead('Receipts', `${plural(claims.length, 'statement')}, oldest first.`)}${timeline(claims)}</section>`;
  return pageShell({
    title: `${s.person}: track record | Receipts`,
    description: `${s.person}'s public predictions, quoted verbatim and graded against evidence.`,
    home: links.home,
    nav: [
      { href: '#drift', label: 'Drift' },
      { href: '#receipts', label: 'Receipts' },
    ],
    body,
    nonce: opts.nonce,
    updated: ledger.updatedAt,
  });
}

export function renderNotFound(message: string, opts: RenderOptions = {}): string {
  const links = linksFor('person', opts.live ?? false);
  return pageShell({
    title: 'Not found | Receipts',
    home: links.home,
    body: `<section class="hero"><p class="eyebrow">404</p><h1>No receipt here.</h1><p class="lede">${esc(message)} <a href="${esc(links.home)}">Back to the leaderboard</a>.</p></section>`,
  });
}

// ---- Fragments for the live server -------------------------------------------------

/** One receipt card for the live page (SSE ingest events). */
export function renderReceipt(c: Claim, opts: { animate?: 'card' | 'stamp' } = {}): string {
  return receiptCard(c, { personHref: linksFor('index', true).person(c.personSlug), animate: opts.animate });
}

/** Compact receipts under an ask answer. */
export function renderAskReceipts(claims: Claim[]): string {
  if (!claims.length) return '';
  const links = linksFor('index', true);
  const items = claims
    .map(
      (c) => `<li>${claimStamp(c, { small: true })}<div><q>${esc(c.quote)}</q>
<p class="mini-claim">${esc(c.claim)}</p>
<p class="mini-meta">${esc(c.person)} · ${esc(fmtDate(c.saidDate))} · <a href="${esc(`${links.person(c.personSlug)}#c-${c.id}`)}">receipt</a></p></div></li>`,
    )
    .join('');
  return `<ul class="mini" aria-label="Receipts cited">${items}</ul>`;
}

// ---- Static site ------------------------------------------------------------------

/** Write index.html and people/<slug>.html under outDir; returns the written paths. */
export function writeSite(l: Ledger, outDir: string): string[] {
  const ledger = withDetectedDrift(l);
  const scores = scoreAll(ledger);
  mkdirSync(join(outDir, 'people'), { recursive: true });
  const written: string[] = [];
  const indexPath = join(outDir, 'index.html');
  writeFileSync(indexPath, renderIndex(ledger, scores));
  written.push(indexPath);
  for (const s of scores) {
    const path = join(outDir, 'people', `${fileSlug(s.personSlug)}.html`);
    writeFileSync(path, renderPerson(ledger, s.personSlug));
    written.push(path);
  }
  return written;
}

// ---- Live page script ------------------------------------------------------------
// Vanilla JS, no build step. EventSource cannot POST, so the ingest stream is
// read with fetch + a ReadableStream reader and parsed as SSE frames. Server
// text goes in through textContent; card HTML is rendered (and escaped) on
// the server. Written without template literals so it can live in this string.

export const LIVE_SCRIPT = `
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var ingestForm = $('ingest-form'), ingestBtn = $('ingest-btn'), ingestStatus = $('ingest-status');
  var ingestError = $('ingest-error'), log = $('ingest-log'), liveFeed = $('live-feed'), feed = $('new-receipts');
  var askForm = $('ask-form'), askBtn = $('ask-btn'), q = $('q'), askError = $('ask-error'), answer = $('ask-answer');
  var running = false;

  function clock() { return new Date().toTimeString().slice(0, 8); }
  function showError(el, message) { el.textContent = message; el.hidden = false; }
  function hideError(el) { el.textContent = ''; el.hidden = true; }
  function friendly(err) {
    if (err && err.name === 'TypeError') return 'Could not reach the Receipts server. Is it still running?';
    return (err && err.message) || String(err);
  }
  async function errorFrom(res) {
    try { var body = await res.json(); if (body && body.error) return body.error; } catch (e) { /* not JSON */ }
    return 'The server answered ' + res.status + (res.statusText ? ' ' + res.statusText : '') + '.';
  }

  var syncLine = null;
  function logLine(stage, message) {
    // GBrain writes arrive one per row: keep them on one line that updates in place.
    if (stage === 'sync' && syncLine) { syncLine.querySelector('.msg').textContent = message; return; }
    var li = document.createElement('li');
    var t = document.createElement('time'); t.textContent = clock();
    var s = document.createElement('span'); s.className = 'st st-' + stage; s.textContent = stage;
    var m = document.createElement('span'); m.className = 'msg'; m.textContent = message;
    li.append(t, s, m);
    if (stage === 'sync') syncLine = li;
    log.append(li);
    log.scrollTop = log.scrollHeight;
  }

  async function readEvents(res, onEvent) {
    var reader = res.body.getReader(), decoder = new TextDecoder(), buf = '';
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      var cut;
      while ((cut = buf.indexOf('\\n\\n')) >= 0) {
        var frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
        var data = frame.split('\\n').filter(function (l) { return l.indexOf('data:') === 0; })
          .map(function (l) { return l.slice(5).replace(/^ /, ''); }).join('\\n');
        if (data) onEvent(JSON.parse(data));
      }
    }
  }

  function placeCard(ev) {
    if (ev.replacedId) {
      var gone = feed.querySelector('[data-claim-id="' + CSS.escape(ev.replacedId) + '"]');
      if (gone) gone.remove();
    }
    var tpl = document.createElement('template');
    tpl.innerHTML = ev.html.trim();
    var card = tpl.content.firstElementChild;
    if (!card) return;
    var id = ev.claim && ev.claim.id;
    var old = id ? feed.querySelector('[data-claim-id="' + CSS.escape(id) + '"]') : null;
    if (old) old.replaceWith(card); else feed.append(card);
    liveFeed.hidden = false;
  }

  async function refreshSections() {
    try {
      var res = await fetch('/', { headers: { accept: 'text/html' } });
      var doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      ['stats', 'leaderboard', 'moving', 'latest'].forEach(function (id) {
        var fresh = doc.getElementById(id), old = $(id);
        if (fresh && old) old.replaceWith(document.importNode(fresh, true));
      });
    } catch (e) { /* a reload shows the new numbers */ }
  }

  function finish(ev) {
    ingestStatus.textContent = '';
    var note = document.createElement('p');
    note.className = 'notice notice-ok';
    note.append(ev.message + ' ');
    if (typeof ev.href === 'string' && ev.href.indexOf('/p/') === 0) {
      var a = document.createElement('a'); a.href = ev.href; a.textContent = 'Open the track record';
      note.append(a);
    }
    log.after(note);
  }

  function formData() {
    var data = {};
    new FormData(ingestForm).forEach(function (v, k) { var s = String(v).trim(); if (s) data[k] = s; });
    return data;
  }

  ingestForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (running) return;
    var data = formData();
    if (!data.input || !data.speaker) {
      showError(ingestError, 'Add an episode URL or file path, and the name of the speaker whose claims you want.');
      (data.input ? $('f-speaker') : $('f-input')).focus();
      return;
    }
    running = true;
    ingestBtn.disabled = true; ingestBtn.textContent = 'Working…';
    hideError(ingestError);
    var oldNote = ingestForm.parentNode.querySelector('.notice-ok'); if (oldNote) oldNote.remove();
    log.textContent = ''; log.hidden = false; syncLine = null;
    ingestStatus.textContent = 'This can take a few minutes for a long episode.';
    logLine('start', 'Sending ' + data.input);
    var outcome = null;
    try {
      var res = await fetch('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      if (!res.ok) throw new Error(await errorFrom(res));
      await readEvents(res, function (ev) {
        if (ev.message) logLine(ev.stage, ev.message);
        if (ev.html) placeCard(ev);
        if (ev.stage === 'error') { outcome = 'error'; showError(ingestError, ev.message); }
        if (ev.stage === 'complete') {
          outcome = 'complete'; finish(ev); refreshSections();
          ingestStatus.textContent = 'Writing to GBrain in the background…';
        }
      });
      if (outcome === null) showError(ingestError, 'The connection closed before the ingest finished. The server keeps working; reload in a minute to see the results.');
    } catch (err) {
      showError(ingestError, friendly(err));
      logLine('error', friendly(err));
    } finally {
      running = false;
      ingestBtn.disabled = false; ingestBtn.textContent = 'Ingest episode';
      if (outcome !== null) ingestStatus.textContent = '';
    }
  });

  function renderAnswer(body) {
    answer.textContent = '';
    String(body.answer || '').split(/\\n{2,}/).forEach(function (para) {
      if (!para.trim()) return;
      var p = document.createElement('p'); p.textContent = para.trim(); answer.append(p);
    });
    var notes = [];
    if (!body.usedModel && !body.note) notes.push('Answered offline from the ledger (no model call).');
    if (body.note) notes.push(body.note);
    if (notes.length) { var n = document.createElement('p'); n.className = 'status'; n.textContent = notes.join(' '); answer.append(n); }
    if (body.html) answer.insertAdjacentHTML('beforeend', body.html);
  }

  async function ask(question) {
    question = question.trim();
    if (!question) { showError(askError, 'Type a question first, for example: how much should I trust someone on a topic?'); q.focus(); return; }
    hideError(askError);
    askBtn.disabled = true;
    answer.textContent = '';
    var wait = document.createElement('p'); wait.className = 'status'; wait.textContent = 'Checking the ledger…'; answer.append(wait);
    try {
      var res = await fetch('/api/ask?q=' + encodeURIComponent(question));
      if (!res.ok) throw new Error(await errorFrom(res));
      renderAnswer(await res.json());
    } catch (err) {
      answer.textContent = '';
      showError(askError, friendly(err));
    } finally {
      askBtn.disabled = false;
    }
  }

  // /?input=…&speaker=…&host=…&title=…&date=…&url=… fills the form, so a recorded episode is one click on stage.
  var params = new URLSearchParams(location.search);
  ['input', 'speaker', 'host', 'title', 'date', 'url'].forEach(function (k) {
    var v = params.get(k), field = $('f-' + k);
    if (v && field) field.value = v;
  });
  if (params.get('q')) q.value = params.get('q');

  askForm.addEventListener('submit', function (e) { e.preventDefault(); ask(q.value); });
  document.querySelectorAll('.suggest [data-q]').forEach(function (b) {
    b.addEventListener('click', function () { q.value = b.getAttribute('data-q'); ask(q.value); });
  });
})();
`;

// ---- Pieces the dashboard and person page reuse ---------------------------------

/** Drift chains for one person (live links), notable ones first; '' when no topic has two statements. */
export function personChainsHtml(l: Ledger, personSlug: string): string {
  // Only chains worth reading: the story moved, or a prediction is in it.
  const list = movingChains(withDetectedDrift(l), personSlug).filter((ch) => notableCount(ch) > 0 || ch.claims.some((c) => c.type === 'prediction'));
  if (!list.length) return '';
  const links = linksFor('person', true);
  const sorted = [...list].sort((a, b) => notableCount(b) - notableCount(a));
  return `<div class="chains">${sorted.map((ch) => chainCard(ch, links, false, true)).join('')}</div>`;
}

/** The tiles, topic table and calibration table of the classic person page. */
export function scoresDetailsHtml(s: PersonScore): string {
  return `${tiles(s)}<section class="sec split" aria-label="Breakdown"><div>${topicTable(s)}</div><div>${calibrationTable(s)}</div></section>`;
}
