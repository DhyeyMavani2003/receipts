// Receipts: the one-box dashboard and the simplified person page. One
// column, large type, plain words. Everything a person sees here is escaped
// on the server; the page script only inserts server-rendered HTML or sets
// textContent.

import { claimsFor } from '../ledger.ts';
import { scoreAll, scorePerson } from '../score.ts';
import type { AnswerResult, Candidate, Claim, DiscoveredCandidate, DiscoveryRecord, DiscoveryStore, Ledger, PersonScore, Watchlist } from '../types.ts';
import type { FeedItem } from './feed.ts';
import { personChainsHtml, scoresDetailsHtml, topicLabel, withDetectedDrift } from './render.ts';
import {
  CALIBRATION_NOTE,
  DRIFT_LABEL_TEXT,
  NOTABLE_DRIFT,
  PLAIN_VERDICT,
  esc,
  fmtClock,
  fmtDate,
  pageShell,
  plural,
  receiptCard,
  recordLine,
  safeHref,
  verdictTone,
} from './theme.ts';
import type { AppMode } from './theme.ts';

// ---- Data ---------------------------------------------------------------------------

export interface PersonCardData {
  name: string;
  slug: string;
  followed: boolean;
  record: string;
  waiting: number;
  claims: number;
  lastReceipt?: string;
  lastCheckedAt?: string;
  newAppearances: number;
  storyMoved?: string;
  discoveries?: DiscoveryRecord;
}

export interface DashboardData {
  today: string;
  cards: PersonCardData[];
  alsoOnRecord: { name: string; slug: string }[];
  feed: FeedItem[];
  chips: string[];
  emptyLedger: boolean;
}

function lastNotableDrift(claims: Claim[]): Claim | undefined {
  return [...claims]
    .filter((c) => c.drift && NOTABLE_DRIFT.has(c.drift.label))
    .sort((a, b) => b.saidDate.localeCompare(a.saidDate))[0];
}

export function storyMovedText(claims: Claim[]): string | undefined {
  const c = lastNotableDrift(claims);
  if (!c) return undefined;
  return `Story moved on ${topicLabel(c.topic)} (${DRIFT_LABEL_TEXT[c.drift!.label].toLowerCase()})`;
}

export function cardData(l: Ledger, slug: string, opts: { name?: string; followed: boolean; lastCheckedAt?: string; discoveries?: DiscoveryRecord }): PersonCardData {
  const claims = claimsFor(l, slug);
  const s: PersonScore | null = claims.length ? scorePerson(claims) : null;
  const last = claims.reduce<string | undefined>((m, c) => (!m || c.saidDate > m ? c.saidDate : m), undefined);
  const card: PersonCardData = {
    name: s?.person ?? opts.name ?? slug,
    slug,
    followed: opts.followed,
    record: s ? recordLine(s) : 'No receipts yet',
    waiting: s ? s.pending + s.tooEarly : 0,
    claims: claims.length,
    newAppearances: opts.discoveries?.candidates.filter((c) => c.status === 'new').length ?? 0,
  };
  if (opts.name) card.name = opts.name;
  if (last) card.lastReceipt = last;
  if (opts.lastCheckedAt) card.lastCheckedAt = opts.lastCheckedAt;
  const moved = storyMovedText(claims);
  if (moved) card.storyMoved = moved;
  if (opts.discoveries) card.discoveries = opts.discoveries;
  return card;
}

/** Cards for followed people (most recently active first) plus the other people on record. */
export function peopleData(l: Ledger, w: Watchlist, d: DiscoveryStore): { cards: PersonCardData[]; alsoOnRecord: { name: string; slug: string }[] } {
  const followed = new Set(w.people.map((p) => p.slug));
  const cards = w.people.map((p) => {
    const onRecord = claimsFor(l, p.slug)[0]?.person;
    return cardData(l, p.slug, { name: onRecord ?? p.name, followed: true, lastCheckedAt: p.lastCheckedAt, discoveries: d.bySlug[p.slug] });
  });
  const activity = (c: PersonCardData) => [c.lastCheckedAt?.slice(0, 10) ?? '', c.lastReceipt ?? ''].sort().at(-1)!;
  cards.sort((a, b) => activity(b).localeCompare(activity(a)) || a.name.localeCompare(b.name));
  const alsoOnRecord = scoreAll(l)
    .filter((s) => !followed.has(s.personSlug))
    .map((s) => ({ name: s.person, slug: s.personSlug }));
  return { cards, alsoOnRecord };
}

// ---- Small pieces ---------------------------------------------------------------------

function personHref(slug: string, anchor = ''): string {
  return `/p/${encodeURIComponent(slug)}${anchor ? `#${anchor}` : ''}`;
}

export function relativeTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${plural(h, 'hour')} ago`;
  return `${plural(Math.round(h / 24), 'day')} ago`;
}

function followToggle(name: string, slug: string, followed: boolean): string {
  if (followed) {
    return `<span class="follow-slot"><button type="button" class="pill-btn is-on" data-unfollow-ask="${esc(slug)}" data-name="${esc(name)}" aria-label="Following ${esc(name)}. Click to unfollow.">Following ✓</button></span>`;
  }
  return `<span class="follow-slot"><button type="button" class="pill-btn" data-follow="${esc(name)}">Follow</button></span>`;
}

export function renderPersonCard(c: PersonCardData): string {
  const neverChecked = c.claims === 0 && !c.lastCheckedAt;
  const lines: string[] = [`<p class="pc-record">${esc(c.record)}</p>`];
  if (c.storyMoved) lines.push(`<p class="pc-moved">${esc(c.storyMoved)}</p>`);
  if (neverChecked) lines.push('<p class="pc-meta">Not checked yet.</p>');
  else if (c.lastReceipt) lines.push(`<p class="pc-meta">Last new receipt: ${esc(fmtDate(c.lastReceipt))}</p>`);
  else if (c.lastCheckedAt) lines.push(`<p class="pc-meta">Checked ${esc(relativeTime(c.lastCheckedAt))}</p>`);
  if (c.newAppearances > 0) {
    lines.push(`<p class="pc-new">New appearances: ${c.newAppearances} found <button type="button" class="link-btn" data-review="${esc(c.slug)}" data-name="${esc(c.name)}">Review</button></p>`);
  }
  const check = neverChecked ? 'Find recent appearances' : 'Check for new appearances';
  const actions = `<div class="pc-actions">
<button type="button" class="btn btn-small" data-discover="${esc(c.slug)}" data-name="${esc(c.name)}">${check}</button>
<button type="button" class="btn btn-small btn-quiet" data-fill="${esc(`What has ${c.name} been saying lately?`)}">Ask</button>
</div>`;
  return `<article class="pcard" id="card-${esc(c.slug)}" data-slug="${esc(c.slug)}">
<div class="pc-top"><h3><a href="${esc(personHref(c.slug))}">${esc(c.name)}</a></h3>${followToggle(c.name, c.slug, c.followed)}</div>
${lines.join('\n')}
${actions}
</article>`;
}

const SOURCE_WORD: Record<string, string> = { youtube: 'YouTube', page: 'Web page', audio: 'Audio only' };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isReadable(c: Candidate | DiscoveredCandidate): boolean {
  return c.transcriptSource === 'youtube' || c.transcriptSource === 'page';
}

export function renderCandidateRow(c: Candidate | DiscoveredCandidate, slug: string): string {
  const status = 'status' in c ? c.status : 'new';
  const meta = [c.date ? fmtDate(c.date) : 'Date unknown', c.durationMin ? `${Math.round(c.durationMin)} min` : '', SOURCE_WORD[c.transcriptSource] ?? hostOf(c.url), c.show]
    .filter(Boolean)
    .map(esc)
    .join(' · ');
  const href = safeHref(c.url);
  const title = href ? `<a class="cand-title" href="${href}" target="_blank" rel="noopener noreferrer">${esc(c.title)}</a>` : `<span class="cand-title">${esc(c.title)}</span>`;
  const readable = isReadable(c);
  const pullBtn = (label: string) =>
    `<button type="button" class="btn btn-small" data-pull="${esc(c.url)}" data-slug="${esc(slug)}" data-max="20">${label}</button> <button type="button" class="link-btn small" data-pull="${esc(c.url)}" data-slug="${esc(slug)}" data-max="0">pull the whole thing</button>`;
  let act: string;
  if (!readable) act = '<span class="cand-state muted">No transcript we can read</span>';
  else if (status === 'pulling') act = '<span class="cand-state">Pulling...</span>';
  else if (status === 'pulled') act = `<a class="cand-state ok" href="${esc(personHref(slug, 'receipts'))}">Pulled: ${esc(plural((c as DiscoveredCandidate).receipts ?? 0, 'receipt'))}</a>`;
  else if (status === 'have') act = '<span class="cand-state muted">Already in your receipts</span>';
  else if (status === 'failed') act = `<span class="cand-state bad">Could not pull: ${esc((c as DiscoveredCandidate).error ?? 'unknown reason')}</span> ${pullBtn('Try again')}`;
  else act = pullBtn('Pull receipts');
  const note = c.linkConfirmed ? '' : '<p class="cand-note">link not confirmed by search</p>';
  return `<li class="cand" data-url="${esc(c.url)}">
<p class="cand-meta">${meta}</p>
<p class="cand-head">${title}</p>
${c.why ? `<p class="cand-why">${esc(c.why)}</p>` : ''}${note}
<div class="cand-act">${act}</div>
</li>`;
}

export function renderDiscoveries(name: string, slug: string, rec: DiscoveryRecord | undefined, now: Date = new Date()): string {
  const head = `<h3 class="disc-h">Recent appearances for ${esc(name)}</h3>`;
  if (!rec) {
    return `<section class="disc" data-disc="${esc(slug)}">${head}<p class="muted">Not checked yet.</p><button type="button" class="btn btn-small" data-discover="${esc(slug)}" data-name="${esc(name)}">Find recent appearances</button></section>`;
  }
  const sub = `<p class="disc-sub">checked ${esc(relativeTime(rec.checkedAt, now))} · since ${esc(fmtDate(rec.since))}</p>`;
  const rows = [...rec.candidates].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const readable = rows.filter(isReadable);
  const rest = rows.filter((c) => !isReadable(c));
  const restHtml = rest.length
    ? `<details class="cands-more"><summary>${esc(plural(rest.length, 'more appearance'))} we can't read yet (audio only or no transcript)</summary><ol class="cands">${rest.map((c) => renderCandidateRow(c, slug)).join('')}</ol></details>`
    : '';
  const body = rows.length
    ? `${readable.length ? `<ol class="cands">${readable.map((c) => renderCandidateRow(c, slug)).join('')}</ol>` : '<p class="muted">None of these has a transcript we can read yet.</p>'}${restHtml}`
    : `<p class="muted">No new long-form appearances found since ${esc(fmtDate(rec.since))}.</p>`;
  const again = `<button type="button" class="link-btn" data-discover="${esc(slug)}" data-name="${esc(name)}" data-force="1">Search again</button>`;
  return `<section class="disc" data-disc="${esc(slug)}">${head}${sub}${body}<p class="disc-foot">${again}</p></section>`;
}

const FEED_ICON: Record<FeedItem['kind'], string> = { new_receipts: 'New', came_due: 'Due', coming_due: 'Soon', story_moved: 'Moved', discovered: 'Found' };

export function renderFeed(items: FeedItem[]): string {
  if (!items.length) return '<p class="empty-line">Nothing new yet. Follow someone or paste a link to get started.</p>';
  return `<ul class="feed-list">${items
    .map(
      (i) =>
        `<li class="fi fi-${esc(i.kind)}"><span class="fi-tag">${esc(FEED_ICON[i.kind])}</span><a href="${esc(i.href)}">${esc(i.text)}</a><time datetime="${esc(i.date)}">${esc(fmtDate(i.date))}</time></li>`,
    )
    .join('')}</ul>`;
}

function verdictPill(v: Claim['verdict']): string {
  return `<span class="vpill ${verdictTone(v)}">${esc(PLAIN_VERDICT[v])}</span>`;
}

/** Only predictions have a deadline and a grade; stances and facts get a neutral label. */
function receiptPill(c: AnswerResult['receipts'][number]): string {
  if (c.type === 'stance') return '<span class="vpill v-neutral">Stance, not a prediction</span>';
  if (c.type === 'factual') return '<span class="vpill v-neutral">Fact, on record</span>';
  return verdictPill(c.verdict);
}

/** The receipts an answer cites, compact. */
export function renderAnswerReceipts(r: AnswerResult['receipts']): string {
  if (!r.length) return '';
  return `<ol class="a-rcpts">${r
    .map((c) => {
      const src = safeHref(c.sourceUrl);
      const jump = safeHref(c.deepLink);
      const at = jump ? /[?&]t=(\d+)/.exec(c.deepLink ?? '')?.[1] : undefined;
      const links = [
        src ? `<a href="${src}" target="_blank" rel="noopener noreferrer">source</a>` : '',
        jump ? `<a href="${jump}" target="_blank" rel="noopener noreferrer">▶ ${esc(at ? fmtClock(Number(at)) : 'play')}</a>` : '',
        `<a href="${esc(personHref(c.personSlug, `c-${c.id}`))}">receipt</a>`,
      ]
        .filter(Boolean)
        .join(' · ');
      return `<li><p class="ar-meta"><time datetime="${esc(c.saidDate)}">${esc(fmtDate(c.saidDate))}</time> · <a href="${esc(personHref(c.personSlug))}">${esc(c.person)}</a> ${receiptPill(c)}</p>
<q class="ar-quote">${esc(c.quote)}</q>
<p class="ar-links">${links}</p></li>`;
    })
    .join('')}</ol>`;
}

/** "2026-09-15" -> "Sep 15, 2026" in prose. */
export function humanizeDates(text: string): string {
  return text.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (d) => fmtDate(d));
}

export function renderAnswerCard(a: AnswerResult, extraNote?: string): string {
  const paras = a.answer
    .replace(/\\"/g, '"')
    .split(/\n\s*\n|\n(?=\d{4}-\d{2}-\d{2}:|\d+\. )/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(humanizeDates(p)).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const actions = a.actions
    .map((x) => {
      if (x.type === 'follow') return `<button type="button" class="btn btn-small" data-follow="${esc(x.name)}">${esc(x.label)}</button>`;
      if (x.type === 'discover') return `<button type="button" class="btn btn-small btn-quiet" data-discover="${esc(x.slug)}" data-name="${esc(x.name)}">${esc(x.label)}</button>`;
      return `<a class="btn btn-small btn-quiet" href="${esc(personHref(x.slug))}">${esc(x.label)}</a>`;
    })
    .join('');
  const chips = a.followUps.map((q) => `<button type="button" class="qchip" data-q="${esc(q)}">${esc(q)}</button>`).join('');
  const notes = [a.note, extraNote].filter(Boolean);
  const based = a.receipts.length ? `<h4 class="a-sub">Based on ${esc(plural(a.receipts.length, 'receipt'))}</h4>${renderAnswerReceipts(a.receipts)}` : '';
  return `<article class="answer-card">
<p class="a-q">You asked: ${esc(a.question)}</p>
<div class="a-body">${paras}</div>
${based}
${actions ? `<div class="a-actions">${actions}</div>` : ''}
${chips ? `<div class="a-more"><p class="a-sub">You could also ask</p><div class="chips">${chips}</div></div>` : ''}
${notes.map((n) => `<p class="a-note">${esc(n)}</p>`).join('')}
</article>`;
}

// ---- Dashboard ------------------------------------------------------------------------

function box(opts: { placeholder: string; personSlug?: string; id?: string }): string {
  const scope = opts.personSlug ? ` data-person="${esc(opts.personSlug)}"` : '';
  return `<form class="box" id="box-form" role="search" autocomplete="off"${scope}>
<label class="vh" for="box">${esc(opts.placeholder)}</label>
<div class="box-row"><input id="box" name="q" type="text" maxlength="500" placeholder="${esc(opts.placeholder)}" spellcheck="false" autocomplete="off"><button class="btn btn-go" type="submit" id="box-go">Go</button></div>
</form>`;
}

const ACTIVITY = `<section class="activity" id="activity" hidden aria-live="polite">
<div class="act-bar"><p class="act-title" id="act-title"></p><button type="button" class="link-btn" data-clear>Clear</button></div>
<div id="act-body"></div>
</section>`;

function ingestForm(): string {
  return `<details class="advanced" id="ingest">
<summary>Advanced: pull an episode with details</summary>
<p class="hint">For a transcript file on this computer, or when you want to set the speaker, host, title and date yourself.</p>
<form id="ingest-form" novalidate>
<div class="fields">
<div class="field wide"><label for="f-input">Episode link or file path</label><input id="f-input" name="input" type="text" autocomplete="off" spellcheck="false" placeholder="https://www.youtube.com/watch?v=... or ./episode.vtt"></div>
<div class="field"><label for="f-speaker">Speaker</label><input id="f-speaker" name="speaker" type="text" autocomplete="off" placeholder="Full name"></div>
<div class="field"><label for="f-date">Date said <span>optional</span></label><input id="f-date" name="date" type="date"></div>
<div class="field"><label for="f-host">Host <span>optional</span></label><input id="f-host" name="host" type="text" autocomplete="off" placeholder="Interviewer's name"></div>
<div class="field wide"><label for="f-title">Title <span>optional</span></label><input id="f-title" name="title" type="text" autocomplete="off"></div>
<div class="field wide"><label for="f-url">Source link <span>needed for local files</span></label><input id="f-url" name="url" type="text" autocomplete="off" spellcheck="false" placeholder="https://..."></div>
</div>
<div class="actions"><button class="btn" type="submit" id="ingest-btn">Pull receipts</button></div>
</form>
</details>`;
}

export function renderDashboard(d: DashboardData, opts: { nonce: string; mode: AppMode }): string {
  const empty = d.emptyLedger && !d.cards.length;
  const hint = empty
    ? 'Start by following someone, for example: follow Jensen Huang'
    : 'Try: follow Jensen Huang · paste a YouTube link · Who has been most wrong about robotaxis?';
  const chips = d.chips.map((q) => `<button type="button" class="qchip" data-q="${esc(q)}">${esc(q)}</button>`).join('');
  const cards = d.cards.length
    ? `<div class="cards" id="cards">${d.cards.map(renderPersonCard).join('')}</div>`
    : '<div class="cards" id="cards"></div><p class="empty-line" id="no-follow">You are not following anyone yet.</p>';
  const also = d.alsoOnRecord.length
    ? `<p class="also">Also on record: ${d.alsoOnRecord
        .slice(0, 10)
        .map((p) => `<a href="${esc(personHref(p.slug))}">${esc(p.name)}</a>`)
        .join(' · ')}${d.alsoOnRecord.length > 10 ? ` and ${d.alsoOnRecord.length - 10} more` : ''}</p>`
    : '';
  const body = `<div class="dash">
<h1 class="dash-h">What did they say, and did it come true?</h1>
${box({ placeholder: 'Follow someone, paste a link, or ask a question' })}
<p class="box-hint">${esc(hint)}</p>
${chips ? `<div class="chips starter">${chips}</div>` : ''}
${ACTIVITY}
<section class="dsec" id="people" aria-labelledby="people-h"><h2 id="people-h">People you follow</h2>${cards}${also}</section>
<section class="dsec" id="whats-new" aria-labelledby="new-h"><h2 id="new-h">What's new</h2>${renderFeed(d.feed)}</section>
${ingestForm()}
</div>`;
  return pageShell({
    title: 'Receipts',
    description: 'Follow people, pull receipts from what they say, and ask how it turned out.',
    home: '/',
    nav: [{ href: '#people', label: 'All people' }],
    body,
    nonce: opts.nonce,
    script: DASHBOARD_SCRIPT,
    badge: { mode: opts.mode },
    extraCss: DASHBOARD_CSS,
  });
}

// ---- Person page ------------------------------------------------------------------------

const FILTERS: [string, string][] = [
  ['all', 'All'],
  ['prediction', 'Predictions'],
  ['correct', 'Came true'],
  ['incorrect', 'Did not happen'],
  ['waiting', 'Waiting'],
];

function filterTags(c: Claim): string {
  const tags = ['all'];
  if (c.type === 'prediction') tags.push('prediction');
  if (c.verdict === 'correct') tags.push('correct');
  if (c.verdict === 'incorrect') tags.push('incorrect');
  if (c.type === 'prediction' && (c.verdict === 'pending' || c.verdict === 'too_early')) tags.push('waiting');
  return tags.join(' ');
}

export interface PersonV2Options {
  nonce: string;
  mode: AppMode;
  followed?: { name: string; lastCheckedAt?: string };
  discoveries?: DiscoveryRecord;
}

export function renderPersonV2(l: Ledger, slug: string, opts: PersonV2Options): string {
  const ledger = withDetectedDrift(l);
  const claims = claimsFor(ledger, slug);
  const card = cardData(ledger, slug, { name: claims[0]?.person ?? opts.followed?.name, followed: !!opts.followed, lastCheckedAt: opts.followed?.lastCheckedAt, discoveries: opts.discoveries });
  const name = card.name;
  const s = claims.length ? scorePerson(claims) : null;
  const newest = [...claims].sort((a, b) => b.saidDate.localeCompare(a.saidDate) || a.id.localeCompare(b.id));
  const chains = personChainsHtml(ledger, slug);
  const check = card.claims === 0 && !card.lastCheckedAt ? 'Find recent appearances' : 'Check for new appearances';
  const receipts = newest.length
    ? `<div class="filters" role="group" aria-label="Show">${FILTERS.map(([k, label], i) => `<button type="button" class="qchip${i === 0 ? ' is-on' : ''}" data-filter="${k}">${esc(label)}</button>`).join('')}</div>
<div class="rlist" id="rlist">${newest.map((c) => `<div class="rwrap" data-tags="${filterTags(c)}">${receiptCard(c, { anchor: true })}</div>`).join('')}</div>`
    : '<p class="empty-line">No receipts yet. Check for new appearances, or paste a link in the box on the dashboard.</p>';
  const body = `<div class="dash person-page">
<nav class="crumbs" aria-label="Breadcrumb"><a href="/">← Dashboard</a></nav>
<header class="pv-head">
<div class="pc-top"><h1>${esc(name)}</h1>${followToggle(name, slug, card.followed)}</div>
<p class="pv-record">${esc(card.record)}</p>
${card.storyMoved ? `<p class="pc-moved">${esc(card.storyMoved)}</p>` : ''}
<div class="pc-actions"><button type="button" class="btn btn-small" data-discover="${esc(slug)}" data-name="${esc(name)}">${check}</button></div>
</header>
${box({ placeholder: `Ask about ${name}...`, personSlug: slug })}
${ACTIVITY}
<section class="dsec" id="moved"><h2>How their views moved</h2>${chains || '<p class="empty-line">Only one statement per topic so far, so nothing to compare over time.</p>'}</section>
<section class="dsec" id="receipts"><h2>Receipts</h2>${receipts}</section>
${card.followed ? `<section class="dsec" id="appearances"><h2>Recent appearances</h2>${renderDiscoveries(name, slug, opts.discoveries)}</section>` : ''}
${s ? `<details class="advanced" id="scores"><summary>Scores and calibration</summary><p class="hint">${esc(CALIBRATION_NOTE)}</p>${scoresDetailsHtml(s)}</details>` : ''}
</div>`;
  return pageShell({
    title: `${name} | Receipts`,
    description: `${name}'s public predictions, quoted word for word and checked against what happened.`,
    home: '/',
    body,
    nonce: opts.nonce,
    script: DASHBOARD_SCRIPT,
    badge: { mode: opts.mode },
    extraCss: DASHBOARD_CSS,
    updated: ledger.updatedAt,
  });
}

// ---- CSS ------------------------------------------------------------------------------

export const DASHBOARD_CSS = `
body{font-size:1.125rem;line-height:1.6}
.dash{max-width:780px;margin:0 auto;padding:1.5rem 0 3rem}
.dash-h{font-size:clamp(1.6rem,3.2vw,2.2rem);margin:.5rem 0 1.25rem;letter-spacing:-.02em}
.badge{display:inline-flex;align-items:center;gap:.45rem;font:600 .85rem/1 var(--font-body);padding:.45rem .75rem;border-radius:999px;border:1px solid var(--rule);background:var(--paper);color:var(--ink-2);white-space:nowrap}
.badge .dot{width:.6rem;height:.6rem;border-radius:50%;background:var(--v-unresolvable)}
.badge-live .dot{background:var(--v-correct);box-shadow:0 0 0 3px color-mix(in srgb,var(--v-correct) 25%,transparent)}
.badge-replay .dot{background:var(--v-partial)}
.box{margin:0}
.box-row{display:flex;gap:.5rem;align-items:stretch}
.box-row input{flex:1;min-width:0;font:400 1.2rem/1.3 var(--font-body);padding:.95rem 1.1rem;border-radius:14px;border:2px solid var(--rule-strong);background:var(--paper);color:var(--ink)}
.box-row input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 18%,transparent)}
.btn-go{font-size:1.1rem;padding:.8rem 1.5rem;border-radius:14px}
.box-hint{color:var(--ink-3);font-size:.95rem;margin:.6rem .2rem .4rem}
.chips{display:flex;flex-wrap:wrap;gap:.5rem}
.chips.starter{margin:.4rem 0 0}
.qchip{font:500 .95rem/1.3 var(--font-body);padding:.5rem .9rem;border-radius:999px;border:1px solid var(--rule-strong);background:var(--paper);color:var(--ink);cursor:pointer;text-align:left}
.qchip:hover{border-color:var(--accent);color:var(--accent)}
.qchip.is-on{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.dash .btn{font-family:var(--font-body);text-transform:none;letter-spacing:0;font-weight:600}
.dash a.btn{text-decoration:none;display:inline-flex;align-items:center}
.btn-small{font-size:.95rem;padding:.5rem .9rem}
.link-btn{background:none;border:0;padding:0;color:var(--accent);font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:.18em}
.link-btn.small{font-size:.9rem}
.pill-btn{font:600 .85rem/1 var(--font-body);padding:.45rem .8rem;border-radius:999px;border:1px solid var(--rule-strong);background:var(--paper);color:var(--ink);cursor:pointer;white-space:nowrap}
.pill-btn.is-on{border-color:var(--v-correct);color:var(--v-correct)}
.activity{margin:1.5rem 0 0;padding:1.25rem 1.4rem;border:1px solid var(--rule);border-radius:16px;background:var(--paper);min-height:5rem}
.act-bar{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-bottom:.4rem}
.act-title{margin:0;font-weight:700;font-size:1.1rem}
.plog{list-style:none;margin:.25rem 0 0;padding:0}
.activity .disc-h,#appearances .disc-h{display:none}
.activity .disc{margin-top:.75rem}
.plog li{padding:.3rem 0 .3rem 1.4rem;position:relative;color:var(--ink-2)}
.plog li::before{content:"";position:absolute;left:.2rem;top:.85rem;width:.5rem;height:.5rem;border-radius:50%;background:var(--rule-strong)}
.plog li.is-now{color:var(--ink)}
.plog li.is-now::before{background:var(--accent);animation:pulse 1.2s ease-in-out infinite}
.plog li.is-bad{color:var(--v-incorrect)}
.plog li.is-bad::before{background:var(--v-incorrect)}
.plog li.is-good{color:var(--ink);font-weight:600}
.plog li.is-good::before{background:var(--v-correct)}
.plog li.is-quiet{color:var(--ink-3);font-size:.95rem}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion: reduce){.plog li.is-now::before{animation:none}}
.act-cards{display:grid;gap:1rem;margin-top:1rem}
.confirm{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-top:.5rem}
.confirm input{font:inherit;padding:.5rem .7rem;border-radius:10px;border:1px solid var(--rule-strong);background:var(--paper);color:var(--ink);min-width:0;flex:1 1 12rem}
.dsec{margin-top:2.75rem}
.dsec>h2{font-size:1.35rem;margin:0 0 1rem}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:1rem}
.pcard{border:1px solid var(--rule);border-radius:16px;background:var(--paper);padding:1.1rem 1.2rem;display:flex;flex-direction:column;gap:.3rem}
.pc-top{display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem}
.pc-top h3{margin:0;font-size:1.25rem}
.pc-top h1{margin:0}
.pc-top a{color:var(--ink);text-decoration:none}
.pc-top a:hover{text-decoration:underline}
.pc-record,.pv-record{margin:0;font-size:1.1rem;font-weight:600}
.pv-record{font-size:1.25rem;margin:.5rem 0}
.pc-moved{margin:0;color:var(--v-partial);font-weight:500}
.pc-meta,.pc-new{margin:0;color:var(--ink-3);font-size:.95rem}
.pc-new{color:var(--ink)}
.pc-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.6rem}
.also{color:var(--ink-3);margin:1rem 0 0;font-size:.98rem}
.empty-line{color:var(--ink-3);margin:.25rem 0}
.feed-list{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.fi{display:grid;grid-template-columns:4.2rem 1fr auto;gap:.75rem;align-items:baseline;padding:.75rem 0;border-bottom:1px solid var(--rule)}
.fi a{color:var(--ink);text-decoration:none}
.fi a:hover{text-decoration:underline}
.fi time{color:var(--ink-3);font-size:.9rem;white-space:nowrap}
.fi-tag{font:700 .72rem/1 var(--font-body);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.fi-came_due .fi-tag{color:var(--v-incorrect)}
.fi-story_moved .fi-tag{color:var(--v-partial)}
.fi-new_receipts .fi-tag,.fi-discovered .fi-tag{color:var(--accent)}
.disc-h{margin:0;font-size:1.15rem}
.disc-sub{margin:.1rem 0 .6rem;color:var(--ink-3);font-size:.92rem}
.disc-foot{margin:.75rem 0 0;font-size:.95rem}
.cands{list-style:none;margin:0;padding:0}
.cands-more{margin-top:.6rem}
.r-foot,.pill-by{display:none}
.act-more{margin-top:.5rem}
.act-more>summary{cursor:pointer;color:var(--ink-3)}
.act-all{display:inline-block;margin-top:.5rem}
.cands-more>summary{cursor:pointer;color:var(--ink-3);font-size:.9rem}
.vpill.v-neutral{color:var(--ink-3)}
.cand{padding:.85rem 0;border-top:1px solid var(--rule)}
.cand p{margin:0}
.cand-meta{color:var(--ink-3);font-size:.9rem}
.cand-head{font-weight:600;margin:.15rem 0}
.cand-title{color:var(--ink)}
.cand-why{color:var(--ink-2);font-size:.98rem}
.cand-note{color:var(--ink-3);font-size:.85rem}
.cand-act{margin-top:.5rem;display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;min-height:2.3rem}
.cand-state{font-weight:600}
.cand-state.ok{color:var(--v-correct)}
.cand-state.bad{color:var(--v-incorrect);font-weight:500}
.muted{color:var(--ink-3)}
.answer-card .a-q{color:var(--ink-3);font-size:.95rem;margin:0 0 .5rem}
.a-body p{margin:0 0 .75rem;font-size:1.15rem;line-height:1.6}
.a-sub{font:700 .8rem/1.2 var(--font-body);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);margin:1.1rem 0 .5rem}
.a-rcpts{list-style:none;margin:0;padding:0}
.a-rcpts li{padding:.7rem 0;border-top:1px solid var(--rule)}
.a-rcpts p{margin:0}
.ar-meta{font-size:.92rem;color:var(--ink-3)}
.ar-meta a{color:var(--ink-2)}
.ar-quote{display:block;margin:.25rem 0;font-size:1.02rem}
.ar-links{font-size:.9rem}
.vpill{display:inline-block;margin-left:.35rem;padding:.12rem .5rem;border-radius:999px;font:600 .78rem/1.3 var(--font-body);border:1px solid currentColor}
.vpill.v-correct{color:var(--v-correct)}
.vpill.v-incorrect{color:var(--v-incorrect)}
.vpill.v-partial{color:var(--v-partial)}
.vpill.v-open{color:var(--v-open)}
.vpill.v-unresolvable{color:var(--v-unresolvable)}
.a-actions{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}
.a-note{color:var(--ink-3);font-size:.92rem;margin:.75rem 0 0}
.advanced{margin-top:3rem;border-top:1px solid var(--rule);padding-top:1rem}
.advanced summary{cursor:pointer;color:var(--ink-2);font-weight:600}
.advanced .fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:.75rem;margin-top:1rem}
.advanced .field{display:flex;flex-direction:column;gap:.3rem}
.advanced .field.wide{grid-column:1/-1}
.advanced label{font-weight:600;font-size:.95rem}
.advanced label span{color:var(--ink-3);font-weight:400}
.advanced input{font:inherit;padding:.55rem .7rem;border-radius:10px;border:1px solid var(--rule-strong);background:var(--paper);color:var(--ink)}
.advanced .actions{margin-top:1rem}
.filters{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem}
.rlist{display:grid;gap:1rem}
.person-page .box{margin-top:1.5rem}
.pv-head h1{font-size:clamp(1.8rem,4vw,2.6rem)}
@media (max-width:560px){
  .dash{padding-top:1rem}
  .box-row{flex-direction:column}
  .btn-go{width:100%}
  .fi{grid-template-columns:1fr;gap:.2rem}
  .fi time{order:-1}
  .activity{padding:1rem}
}
`;

// ---- Page script --------------------------------------------------------------------
// Vanilla JS, no build step, no template literals. Server text goes in through
// textContent; HTML fragments come from the server, already escaped. Streams
// are fetch + ReadableStream parsed as SSE frames (EventSource cannot POST).

export const DASHBOARD_SCRIPT = String.raw`
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var form = $('box-form'), box = $('box'), go = $('box-go');
  var activity = $('activity'), actBody = $('act-body'), actTitle = $('act-title');
  var personScope = form ? form.getAttribute('data-person') : null;
  var runId = 0;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function frag(html) {
    var t = document.createElement('template');
    t.innerHTML = html;
    return t.content;
  }
  function friendly(err) {
    if (err && err.name === 'TypeError') return 'Could not reach Receipts. Is the server still running?';
    return (err && err.message) || 'Something went wrong. Try again.';
  }
  async function readError(res) {
    try { var j = await res.json(); if (j && j.error) return j.error; } catch (e) {}
    return 'Something went wrong (' + res.status + '). Try again.';
  }
  async function postJson(url, body) {
    var res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await readError(res));
    return res.json();
  }
  async function stream(url, body, onEvent) {
    var res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await readError(res));
    var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        var frame = buf.slice(0, i); buf = buf.slice(i + 2);
        var data = frame.split('\n').filter(function (l) { return l.indexOf('data:') === 0; }).map(function (l) { return l.slice(5).trim(); }).join('');
        if (data) { try { onEvent(JSON.parse(data)); } catch (e) { /* ignore a bad frame */ } }
      }
    }
  }

  // ---- Activity area ----
  function openActivity(title) {
    runId++;
    activity.hidden = false;
    actTitle.textContent = title || '';
    actBody.textContent = '';
    return runId;
  }
  function clearActivity() { runId++; activity.hidden = true; actBody.textContent = ''; actTitle.textContent = ''; }
  function newLog(parent) { var ol = el('ol', 'plog'); (parent || actBody).appendChild(ol); return ol; }
  function line(log, text, kind) {
    var prev = log.querySelector('li.is-now');
    if (prev) prev.classList.remove('is-now');
    var li = el('li', kind ? 'is-' + kind : 'is-now', text);
    log.appendChild(li);
    return li;
  }
  function done(log) { var prev = log.querySelector('li.is-now'); if (prev) prev.classList.remove('is-now'); }
  function busy(on) { if (go) { go.disabled = on; go.textContent = on ? 'Working...' : 'Go'; } }

  // ---- Ask ----
  async function ask(q) {
    var id = openActivity('Answer');
    var log = newLog();
    line(log, 'Reading your receipts...');
    try {
      var body = { q: q };
      if (personScope) body.personSlug = personScope;
      var a = await postJson('/api/ask', body);
      if (id !== runId) return;
      actBody.textContent = '';
      actBody.appendChild(frag(a.html));
    } catch (err) {
      if (id !== runId) return;
      done(log); line(log, friendly(err), 'bad');
    }
  }

  // ---- Discover ----
  var discovering = {};
  async function discover(nameOrSlug, opts) {
    opts = opts || {};
    var id;
    if (opts.keep) { id = runId; if (opts.title) actTitle.textContent = opts.title; }
    else id = openActivity(opts.title || 'Recent appearances');
    var log = opts.log || newLog();
    var list = el('ol', 'cands');
    var panel = el('div', 'disc-live');
    actBody.appendChild(panel);
    panel.appendChild(list);
    var body = opts.slug ? { slug: opts.slug } : { name: nameOrSlug };
    if (opts.name) body.name = opts.name;
    if (opts.force) body.force = true;
    if (opts.stored) body.stored = true;
    try {
      await stream('/api/discover', body, function (e) {
        if (id !== runId) return;
        if (e.stage === 'waiting') {
          var last = log.lastElementChild;
          if (last && last.getAttribute('data-waiting')) { last.textContent = e.message; return; }
          line(log, e.message).setAttribute('data-waiting', '1');
          return;
        }
        if (e.stage === 'candidate') { if (e.html) list.appendChild(frag(e.html)); return; }
        if (e.stage === 'panel') { panel.textContent = ''; panel.appendChild(frag(e.html)); return; }
        if (e.stage === 'card') { replaceCard(e.slug, e.html); return; }
        if (e.stage === 'error') { done(log); line(log, e.message, 'bad'); return; }
        if (e.stage === 'complete') { done(log); line(log, e.message, 'good'); return; }
        if (e.message) line(log, e.message, e.stage === 'note' ? 'quiet' : null);
      });
    } catch (err) {
      if (id !== runId) return;
      done(log); line(log, friendly(err), 'bad');
    }
    done(log);
  }

  // ---- Pull ----
  async function pull(body, row) {
    var id = runId;
    var holder;
    if (row && activity.contains(row)) {
      holder = el('div', 'pull-live');
      actBody.appendChild(holder);
    } else {
      openActivity('Pulling receipts');
      id = runId;
      holder = actBody;
    }
    var log = newLog(holder);
    var cards = el('div', 'act-cards');
    holder.appendChild(cards);
    var types = {};
    var syncLine = null;
    var act = row ? row.querySelector('.cand-act') : null;
    if (act) { act.textContent = ''; act.appendChild(el('span', 'cand-state', 'Pulling...')); }
    if (holder.scrollIntoView) holder.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var finished = false;
    try {
      await stream('/api/pull', body, function (e) {
        if (id !== runId && holder === actBody) return;
        if ((e.stage === 'verified' || e.stage === 'graded' || e.stage === 'updated') && e.html && e.claim) {
          var old = cards.querySelector('[data-claim-id="' + (window.CSS && CSS.escape ? CSS.escape(e.claim.id) : e.claim.id) + '"]');
          var f = frag(e.html);
          if (old) old.replaceWith(f); else cards.appendChild(f);
          types[e.claim.id] = e.claim.type;
          if (e.stage !== 'graded') return;
        }
        if (e.stage === 'sync') {
          if (!syncLine) syncLine = line(log, e.message, 'quiet'); else syncLine.textContent = e.message;
          return;
        }
        if (e.stage === 'error') {
          done(log); line(log, e.message, 'bad');
          if (act) { act.textContent = ''; act.appendChild(el('span', 'cand-state bad', 'Could not pull. See the message above.')); }
          return;
        }
        if (e.stage === 'complete') {
          finished = true;
          done(log);
          var li = line(log, e.message, 'good');
          if (e.href) { li.appendChild(document.createTextNode(' ')); var a = el('a', '', e.person ? 'See ' + e.person + "'s page" : 'See their page'); a.href = e.href; li.appendChild(a); }
          if (act) { act.textContent = ''; var ok = el('a', 'cand-state ok', 'Pulled: ' + (e.count || 0) + (e.count === 1 ? ' receipt' : ' receipts')); ok.href = e.href || '#'; act.appendChild(ok); }
          summarizeCards(cards, types, log, e.href, e.person);
          refreshSections();
          return;
        }
        if (e.message) line(log, e.message, e.stage === 'warning' ? 'quiet' : null);
      });
    } catch (err) {
      done(log); line(log, friendly(err), 'bad');
      if (act && !finished) { act.textContent = ''; act.appendChild(el('span', 'cand-state bad', 'Could not pull.')); }
    }
    done(log);
  }

  // After a pull: one summary line, the top three receipts (predictions first),
  // and the rest folded away, so the dashboard stays one screen.
  function summarizeCards(cards, types, log, href, person) {
    var list = Array.prototype.slice.call(cards.children);
    if (!list.length) return;
    var n = { prediction: 0, stance: 0, factual: 0 };
    list.forEach(function (c) { var t = types[c.getAttribute('data-claim-id')]; if (n[t] !== undefined) n[t]++; });
    var parts = [];
    if (n.prediction) parts.push(n.prediction + (n.prediction === 1 ? ' prediction' : ' predictions'));
    if (n.stance) parts.push(n.stance + (n.stance === 1 ? ' stance' : ' stances'));
    if (n.factual) parts.push(n.factual + (n.factual === 1 ? ' fact' : ' facts'));
    line(log, list.length + (list.length === 1 ? ' receipt' : ' receipts') + (parts.length ? ': ' + parts.join(', ') : '') + '.' + (n.prediction ? '' : ' None has a deadline to grade yet.'), 'quiet');
    done(log);
    var rank = function (c) { return types[c.getAttribute('data-claim-id')] === 'prediction' ? 0 : 1; };
    list.sort(function (a, b) { return rank(a) - rank(b); });
    list.forEach(function (c) { cards.appendChild(c); });
    if (list.length <= 3) return;
    var more = el('details', 'act-more');
    var s = el('summary', '', 'Show the other ' + (list.length - 3) + ' here');
    more.appendChild(s);
    list.slice(3).forEach(function (c) { more.appendChild(c); });
    cards.appendChild(more);
    if (href) { var all = el('a', 'act-all', 'See all on ' + (person ? person + "'s" : 'their') + ' page'); all.href = href; cards.appendChild(all); }
  }
  // Re-render the people cards, the feed and the starter chips from the server.
  async function refreshSections() {
    if (!$('people') && !$('whats-new')) return;
    try {
      var res = await fetch('/', { headers: { accept: 'text/html' } });
      if (!res.ok) return;
      var doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      ['people', 'whats-new'].forEach(function (sid) {
        var cur = $(sid), next = doc.getElementById(sid);
        if (cur && next) cur.innerHTML = next.innerHTML;
      });
      var chipsNow = document.querySelector('.chips.starter'), chipsNext = doc.querySelector('.chips.starter');
      if (chipsNow && chipsNext) chipsNow.innerHTML = chipsNext.innerHTML;
      else if (chipsNow && !chipsNext) chipsNow.remove();
    } catch (err) { /* the page still works; a reload shows the new state */ }
  }

  // ---- Follow / unfollow ----
  function replaceCard(slug, html) {
    var cardsEl = $('cards');
    if (!cardsEl || !html) return;
    var old = $('card-' + slug);
    var f = frag(html);
    if (old) old.replaceWith(f); else cardsEl.insertBefore(f, cardsEl.firstChild);
    var none = $('no-follow'); if (none) none.hidden = true;
  }
  async function followThenDiscover(name) {
    var id = openActivity('Following ' + name);
    var log = newLog();
    try {
      var r = await postJson('/api/follow', { name: name });
      if (id !== runId) return;
      var li = line(log, 'Following ' + r.person.name + '.', 'good');
      var undo = el('button', 'link-btn', 'Undo');
      undo.type = 'button';
      undo.setAttribute('data-undo-follow', r.person.slug);
      li.appendChild(document.createTextNode(' '));
      li.appendChild(undo);
      replaceCard(r.person.slug, r.html);
      await discover(r.person.name, { slug: r.person.slug, name: r.person.name, log: log, title: 'Recent appearances for ' + r.person.name, keep: true });
      refreshSections();
    } catch (err) {
      if (id !== runId) return;
      done(log); line(log, friendly(err), 'bad');
    }
  }
  async function unfollow(slug, name) {
    try {
      await postJson('/api/unfollow', { name: slug });
      var card = $('card-' + slug);
      if (card) card.remove();
      refreshSections();
      var slot = document.querySelector('.pv-head .follow-slot');
      if (slot) { slot.textContent = ''; var b = el('button', 'pill-btn', 'Follow'); b.type = 'button'; b.setAttribute('data-follow', name); slot.appendChild(b); }
    } catch (err) {
      openActivity('Unfollow'); line(newLog(), friendly(err), 'bad');
    }
  }

  // ---- Routing the one box ----
  function askSpeaker(route) {
    openActivity('Whose words should I pull from this?');
    if (route.title) actBody.appendChild(el('p', 'muted', route.title));
    var wrap = el('div', 'confirm');
    var onPage = Array.prototype.slice.call(document.querySelectorAll('.pcard h3 a, .also a')).map(function (a) { return a.textContent; });
    var people = (route.suggest || []).concat(onPage).filter(function (n, i, all) { return n && all.indexOf(n) === i; });
    var whole = el('input'); whole.type = 'checkbox'; whole.id = 'pull-whole';
    var minutes = function () { return whole.checked ? undefined : 20; };
    var go = function (n) { var b = { url: route.url, speaker: n }; if (minutes()) b.maxMinutes = minutes(); pull(b); };
    people.slice(0, 6).forEach(function (n, i) {
      var b = el('button', i < (route.suggest || []).length ? 'qchip is-on' : 'qchip', n); b.type = 'button';
      b.addEventListener('click', function () { go(n); });
      wrap.appendChild(b);
    });
    var input = el('input'); input.placeholder = 'Or type their name'; input.maxLength = 120;
    var ok = el('button', 'btn btn-small', 'Pull receipts'); ok.type = 'button';
    ok.addEventListener('click', function () { var n = input.value.trim(); if (n) go(n); });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); ok.click(); } });
    wrap.appendChild(input); wrap.appendChild(ok);
    actBody.appendChild(wrap);
    var wl = el('label', 'muted small'); wl.appendChild(whole); wl.appendChild(document.createTextNode(' Pull the whole thing (slower; otherwise the first 20 minutes)'));
    actBody.appendChild(wl);
    if (!(route.suggest || []).length) input.focus();
  }
  function openAdvanced(path) {
    var d = $('ingest');
    if (!d) { window.location.href = '/?input=' + encodeURIComponent(path) + '#ingest'; return; }
    d.open = true;
    $('f-input').value = path;
    openActivity('A file on this computer');
    line(newLog(), 'Files need a speaker and a source link. Fill them in under Advanced below.', 'quiet');
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function submit(text) {
    text = (text || '').trim();
    if (!text) { box.focus(); return; }
    busy(true);
    try {
      if (personScope) { await ask(text); return; }
      var r = (await postJson('/api/input', { text: text })).route;
      if (r.kind === 'ask') await ask(text);
      else if (r.kind === 'follow') { box.value = ''; await followThenDiscover(r.name); }
      else if (r.kind === 'unfollow') { await unfollow(r.slug || r.name, r.name); openActivity('Unfollowed'); line(newLog(), 'No longer following ' + r.name + '. Their receipts stay.', 'good'); }
      else if (r.kind === 'discover') await discover(r.name, { slug: r.slug, name: r.name, title: 'Recent appearances for ' + r.name });
      else if (r.kind === 'person') { openActivity(r.name); var card = $('card-' + r.slug); if (card) actBody.appendChild(card.cloneNode(true)); else { var a = el('a', '', 'Open ' + r.name + "'s page"); a.href = '/p/' + encodeURIComponent(r.slug); actBody.appendChild(a); } }
      else if (r.kind === 'pull') {
        if (!/^https?:\/\//i.test(r.url || '')) openAdvanced(r.url || text);
        else if (!r.speaker) askSpeaker(r);
        else await pull({ url: r.url, speaker: r.speaker, maxMinutes: 20 });
      } else await ask(text);
    } catch (err) {
      openActivity('Something went wrong'); line(newLog(), friendly(err), 'bad');
    } finally { busy(false); }
  }

  // Phones: the long placeholder is cut off, so use the short one.
  if (box && !personScope && window.matchMedia && window.matchMedia('(max-width: 480px)').matches) box.placeholder = 'Name, link, or question';

  if (form) form.addEventListener('submit', function (ev) { ev.preventDefault(); submit(box.value); });

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('button, [data-q]');
    if (!t) return;
    var d = t.dataset;
    if (d.q !== undefined) { ev.preventDefault(); box.value = d.q; submit(d.q); return; }
    if (d.fill !== undefined) { box.value = d.fill; box.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (t.hasAttribute('data-clear')) { clearActivity(); return; }
    if (d.follow !== undefined) { followThenDiscover(d.follow); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (d.undoFollow !== undefined) { unfollow(d.undoFollow, ''); clearActivity(); return; }
    if (d.discover !== undefined) {
      discover(d.name || d.discover, { slug: d.discover, name: d.name, force: d.force === '1', title: 'Recent appearances for ' + (d.name || d.discover) });
      activity.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (d.review !== undefined) {
      discover(d.name || d.review, { slug: d.review, name: d.name, stored: true, title: 'Recent appearances for ' + (d.name || d.review) });
      activity.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (d.pull !== undefined) {
      var body = { slug: d.slug, url: d.pull };
      if (d.max && d.max !== '0') body.maxMinutes = Number(d.max);
      pull(body, t.closest('.cand'));
      return;
    }
    if (d.unfollowAsk !== undefined) {
      var slot = t.parentNode, name = d.name, slug = d.unfollowAsk;
      var saved = slot.innerHTML;
      slot.textContent = '';
      slot.appendChild(document.createTextNode('Unfollow ' + name + '? '));
      var yes = el('button', 'link-btn', 'Yes'); yes.type = 'button';
      var no = el('button', 'link-btn', 'No'); no.type = 'button';
      yes.addEventListener('click', function () { unfollow(slug, name); });
      no.addEventListener('click', function () { slot.innerHTML = saved; });
      slot.appendChild(yes); slot.appendChild(document.createTextNode(' ')); slot.appendChild(no);
      return;
    }
    if (d.filter !== undefined) {
      document.querySelectorAll('[data-filter]').forEach(function (b) { b.classList.toggle('is-on', b === t); });
      document.querySelectorAll('.rwrap').forEach(function (w) { w.hidden = (' ' + w.getAttribute('data-tags') + ' ').indexOf(' ' + d.filter + ' ') < 0; });
      return;
    }
  });

  // ---- Advanced ingest form (the classic /api/ingest stream) ----
  var ingestForm = $('ingest-form');
  if (ingestForm) {
    var params = new URLSearchParams(location.search);
    ['input', 'speaker', 'host', 'title', 'date', 'url'].forEach(function (k) {
      var v = params.get(k); var f = $('f-' + k);
      if (v && f) f.value = v;
    });
    if (params.get('input') || location.hash === '#ingest') { $('ingest').open = true; }
    ingestForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var body = {};
      ['input', 'speaker', 'host', 'title', 'date', 'url'].forEach(function (k) { var v = $('f-' + k).value.trim(); if (v) body[k] = v; });
      openActivity('Pulling receipts');
      var id = runId;
      var log = newLog();
      var cards = el('div', 'act-cards'); actBody.appendChild(cards);
      var syncLine = null;
      activity.scrollIntoView({ behavior: 'smooth', block: 'start' });
      try {
        await stream('/api/ingest', body, function (e) {
          if (id !== runId) return;
          if (e.html && e.claim) {
            var old = cards.querySelector('[data-claim-id="' + e.claim.id + '"]');
            var f = frag(e.html);
            if (old) old.replaceWith(f); else cards.appendChild(f);
            if (e.stage === 'verified' || e.stage === 'updated') return;
          }
          if (e.stage === 'sync') { if (!syncLine) syncLine = line(log, e.message, 'quiet'); else syncLine.textContent = e.message; return; }
          if (e.stage === 'error') { done(log); line(log, e.message, 'bad'); return; }
          if (e.stage === 'complete') { done(log); var li = line(log, e.message, 'good'); if (e.href) { li.appendChild(document.createTextNode(' ')); var a = el('a', '', 'See their page'); a.href = e.href; li.appendChild(a); } return; }
          if (e.message) line(log, e.message, e.stage === 'warning' || e.stage === 'dropped' ? 'quiet' : null);
        });
      } catch (err) { done(log); line(log, friendly(err), 'bad'); }
      done(log);
    });
  }
})();
`;
