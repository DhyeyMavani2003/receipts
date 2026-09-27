// The "receipt" visual language shared by the static site and the live
// server: tokens + CSS, the page shell, and the small HTML pieces every page
// uses (receipt cards, verdict stamps, drift chips, tally strips). Every
// dynamic string goes through esc(); every href through safeHref().

import { daysBetween } from '../drift.ts';
import { DAYS_PER_MONTH } from '../score.ts';
import type { Claim, ClaimType, DriftInfo, DriftLabel, PersonScore, Verdict } from '../types.ts';

// ---- Escaping ---------------------------------------------------------------

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escape text for element content and quoted attribute values. */
export function esc(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** The URL, escaped for an href, when it is http(s); null for anything else (javascript:, data:, relative junk). */
export function safeHref(url: string | undefined | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return null;
  try {
    new URL(trimmed);
  } catch {
    return null;
  }
  return esc(trimmed);
}

/** Host name for a link label ("www.cnbc.com" -> "cnbc.com"), or '' when unparsable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** External link with safe rel; plain text when the URL is not http(s). */
export function extLink(url: string | undefined, label: string, cls = ''): string {
  const href = safeHref(url);
  const c = cls ? ` class="${cls}"` : '';
  return href ? `<a${c} href="${href}" rel="noopener noreferrer" target="_blank">${esc(label)}</a>` : `<span${c}>${esc(label)}</span>`;
}

// ---- Formatting -------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateParts(date: string): [number, number, number] | null {
  const m = DATE_RE.exec(date);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** "2019-04-22" -> "Apr 22, 2019". Anything else is returned as given. */
export function fmtDate(date: string | undefined): string {
  if (!date) return '';
  const p = dateParts(date);
  return p ? `${MONTHS[p[1] - 1]} ${p[2]}, ${p[0]}` : date;
}

/** "2019-04-22" -> "Apr 2019". */
export function fmtMonth(date: string): string {
  const p = dateParts(date);
  return p ? `${MONTHS[p[1] - 1]} ${p[0]}` : date;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Deadlines read the way people say them: "2020-12-31" -> "2020", "2026-03-31" -> "Mar 2026", else the full date. */
export function fmtDeadline(date: string): string {
  const p = dateParts(date);
  if (!p) return date;
  const [y, m, d] = p;
  if (m === 12 && d === 31) return String(y);
  if (d === lastDayOfMonth(y, m)) return `${MONTHS[m - 1]} ${y}`;
  return fmtDate(date);
}

/** 0.375 -> "38%"; null -> an em dash. */
export function fmtPct(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`;
}

/** Brier score to two decimals; null -> an em dash. */
export function fmtBrier(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : x.toFixed(2);
}

/** 2.4 -> "2.4×"; null -> an em dash. */
export function fmtMultiplier(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : `${x.toFixed(1)}×`;
}

/** Seconds -> "1:02:03" or "4:05". */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---- Verdicts, types, drift -------------------------------------------------

export const VERDICT_LABEL: Record<Verdict, string> = {
  correct: 'Correct',
  incorrect: 'Incorrect',
  partial: 'Partial',
  unresolvable: 'Unresolvable',
  too_early: 'Too early',
  pending: 'Pending',
};

/** CSS tone class: pending and too_early share the slate "open" tone. */
export function verdictTone(v: Verdict): string {
  return v === 'pending' || v === 'too_early' ? 'v-open' : `v-${v}`;
}

export const TYPE_LABEL: Record<ClaimType, string> = { prediction: 'Prediction', stance: 'Stance', factual: 'Factual' };

export const DRIFT_LABEL_TEXT: Record<DriftLabel, string> = {
  first: 'First claim',
  reaffirmed: 'Reaffirmed',
  pushed_later: 'Deadline pushed',
  pulled_earlier: 'Deadline pulled in',
  goalposts_moved: 'Goalposts moved',
  reversed: 'Reversed',
  escalated: 'Escalated',
  softened: 'Softened',
};

/** Labels that change what was promised or when; drawn filled to stand out. */
export const NOTABLE_DRIFT = new Set<DriftLabel>(['pushed_later', 'pulled_earlier', 'goalposts_moved', 'reversed']);

export function verdictStamp(v: Verdict, opts: { disputed?: boolean; small?: boolean; fresh?: boolean } = {}): string {
  const cls = ['stamp', verdictTone(v), opts.small ? 'stamp-sm' : '', opts.fresh ? 'is-new' : ''].filter(Boolean).join(' ');
  const disputed = opts.disputed ? '<span class="stamp-note">disputed</span>' : '';
  return `<span class="${cls}"><span class="vh">Verdict: </span>${esc(VERDICT_LABEL[v])}${disputed}</span>`;
}

/** Stances and factual claims are not graded; they get a quiet "on record" tag instead of a PENDING stamp. */
export function claimStamp(c: Claim, opts: { small?: boolean; fresh?: boolean } = {}): string {
  if (c.type !== 'prediction' && c.verdict === 'pending') {
    return `<span class="tag${opts.small ? ' tag-sm' : ''}">${esc(TYPE_LABEL[c.type])} · on record</span>`;
  }
  return verdictStamp(c.verdict, { ...opts, disputed: c.grading?.disputed });
}

/** Escaped text with YYYY-MM-DD dates kept on one line (browsers break after hyphens). */
export function escKeepDates(text: string): string {
  return esc(text).replace(/\d{4}-\d{2}-\d{2}/g, (d) => `<span class="nw">${d}</span>`);
}

/** Who labeled a drift step, when not the code: "curated label" or "model-judged". */
export function driftLabeledByText(d: DriftInfo): string {
  if (!d.labeledBy) return '';
  return d.labeledBy.startsWith('human:') ? 'curated label' : 'model-judged';
}

export function driftChip(d: DriftInfo | undefined, opts: { withNote?: boolean } = {}): string {
  if (!d || d.label === 'first') return '';
  const notable = NOTABLE_DRIFT.has(d.label) ? ' chip-notable' : '';
  const by = driftLabeledByText(d);
  const title = by ? `${d.note} (${by}: ${d.labeledBy})` : d.note;
  const chip = `<span class="chip${notable}" title="${esc(title)}">${esc(DRIFT_LABEL_TEXT[d.label])}</span>${by ? `<span class="chip-by">${esc(by)}</span>` : ''}`;
  return opts.withNote ? `<p class="r-drift">${chip} <span>${escKeepDates(d.note)}</span></p>` : chip;
}

// ---- Tally strip ------------------------------------------------------------

export interface Tally {
  correct: number;
  partial: number;
  incorrect: number;
  unresolvable: number;
  open: number; // pending + too early
}

export const TALLY_KEYS = ['correct', 'partial', 'incorrect', 'unresolvable', 'open'] as const;
const TALLY_TEXT: Record<(typeof TALLY_KEYS)[number], string> = {
  correct: 'correct',
  partial: 'partial',
  incorrect: 'incorrect',
  unresolvable: 'unresolvable',
  open: 'open',
};

export function tallyText(t: Tally): string {
  return TALLY_KEYS.map((k) => `${t[k]} ${TALLY_TEXT[k]}`).join(', ');
}

/** Stacked strip of prediction outcomes; the numbers stay in the table or legend beside it. */
export function tallyBar(t: Tally): string {
  const total = TALLY_KEYS.reduce((n, k) => n + t[k], 0);
  if (total === 0) return '<span class="tally tally-empty" role="img" aria-label="No predictions yet"></span>';
  const segs = TALLY_KEYS.filter((k) => t[k] > 0)
    .map((k) => `<span class="t t-${k}" style="flex-grow:${t[k]}"></span>`)
    .join('');
  return `<span class="tally" role="img" aria-label="${esc(tallyText(t))}">${segs}</span>`;
}

export function tallyLegend(t?: Tally): string {
  const items = TALLY_KEYS.map((k) => {
    const n = t ? ` <b>${t[k]}</b>` : '';
    return `<li><span class="sw t-${k}" aria-hidden="true"></span>${TALLY_TEXT[k]}${n}</li>`;
  }).join('');
  return `<ul class="legend">${items}</ul>`;
}

// ---- Receipt card -----------------------------------------------------------

export interface CardOptions {
  /** Show the speaker's name, linked here (feeds that mix people). */
  personHref?: string;
  /** Give the card id="c-<id>" so it can be linked to (person pages). */
  anchor?: boolean;
  /** Live ingest: 'card' slides the card in, 'stamp' lands only the verdict stamp (on grading). */
  animate?: 'card' | 'stamp';
}

function kv(label: string, value: string): string {
  return `<div class="kv"><dt>${esc(label)}</dt><span class="dots" aria-hidden="true"></span><dd>${value}</dd></div>`;
}

function hedgeText(c: Claim): string {
  const words = c.hedge.trim() ? `“${esc(c.hedge.trim())}”` : 'plain statement';
  return `${words} <span class="arrow" aria-hidden="true">→</span><span class="vh"> implies </span> ${fmtPct(c.impliedProbability)}`;
}

function quoteFooter(c: Claim): string {
  const parts: string[] = [];
  const jump = safeHref(c.source.deepLink);
  if (jump) {
    const at = c.source.timestampSec !== undefined ? fmtClock(c.source.timestampSec) : 'timestamp';
    parts.push(`<a class="r-jump" href="${jump}" rel="noopener noreferrer" target="_blank"><span aria-hidden="true">▶</span> ${esc(at)}<span class="vh"> (play at this moment)</span></a>`);
  }
  if (!c.quoteVerified) parts.push('<span class="r-unverified">Quote not string-matched to a transcript</span>');
  return parts.length ? `<footer>${parts.join('')}</footer>` : '';
}

function gradedByText(by: string): string {
  if (by === 'human:seed') return 'Curated · sources linked';
  if (by.startsWith('rule:')) return 'Deadline not reached';
  return `Graded by ${by}`;
}

function judgesText(c: Claim): string {
  const votes = c.grading?.judges ?? [];
  if (votes.length < 2) return '';
  if (c.grading?.disputed) return `${votes.length} judges split`;
  return votes.every((v) => v.verdict === votes[0]!.verdict) ? `${votes.length} judges agreed` : `${votes.length} judges, majority`;
}

/** "came true 5 days late" / "came true 14 months late", from the dates; '' when on time or never. */
export function latenessText(c: Claim): string {
  const resolvedOn = c.grading?.resolvedOn;
  if (!c.targetDate || !resolvedOn || (c.verdict !== 'correct' && c.verdict !== 'incorrect')) return '';
  const days = daysBetween(c.targetDate, resolvedOn);
  if (days <= 0) return '';
  if (days < 31) return `came true ${plural(days, 'day')} late`;
  return `came true ${plural(Math.round(days / DAYS_PER_MONTH), 'month')} late`;
}

function evidenceList(c: Claim): string {
  const ev = c.grading?.evidence ?? [];
  if (!ev.length) return '';
  const items = ev
    .map((e) => {
      const host = hostOf(e.url);
      const meta = [host, e.date ? fmtDate(e.date) : ''].filter(Boolean).join(' · ');
      const snippet = e.snippet ? `<q>${esc(e.snippet)}</q>` : '';
      return `<li>${extLink(e.url, e.title || host || e.url, 'ev-link')}<span class="ev-meta">${esc(meta)}</span>${snippet}</li>`;
    })
    .join('');
  return `<ol class="r-evidence" aria-label="Evidence">${items}</ol>`;
}

function verdictSection(c: Claim): string {
  const g = c.grading;
  if (!g) return '';
  const meta = [
    gradedByText(g.gradedBy),
    judgesText(c),
    `${fmtPct(g.confidence)} confidence`,
    g.resolvedOn ? `resolved ${fmtMonth(g.resolvedOn)}` : '',
    latenessText(c),
  ].filter(Boolean);
  return `<section class="r-verdict" aria-label="Verdict">
<p class="r-rationale">${esc(g.rationale)}</p>
${evidenceList(c)}
<p class="r-meta">${meta.map(esc).join(' · ')}</p>
</section>`;
}

function sourceLine(c: Claim): string {
  const kind = c.source.kind.replaceAll('_', ' ');
  return `<p class="r-src"><span>${esc(kind)}</span> · <time datetime="${esc(c.saidDate)}">${esc(fmtDate(c.saidDate))}</time></p>
<p class="r-title">${extLink(c.source.url, c.source.title || c.source.url)}</p>`;
}

export function receiptCard(c: Claim, opts: CardOptions = {}): string {
  const id = opts.anchor ? ` id="c-${esc(c.id)}"` : '';
  const cls = ['receipt', verdictTone(c.verdict), opts.animate === 'card' ? 'is-new' : ''].filter(Boolean).join(' ');
  const who = opts.personHref !== undefined ? `<a class="r-who" href="${esc(opts.personHref)}">${esc(c.person)}</a>` : '';
  const cite = safeHref(c.source.url);
  const due = c.targetDate
    ? `<time datetime="${esc(c.targetDate)}">${esc(fmtDate(c.targetDate))}</time>${c.targetDateInferred ? ' <span class="muted">(inferred)</span>' : ''}`
    : '';
  const rows = [
    c.type === 'prediction' && due ? kv('Due', due) : '',
    // A probability only means something for a prediction; a stance or a fact is shown without one.
    c.type === 'prediction' ? kv('Hedge', hedgeText(c)) : '',
    kv('Topic', `<span class="topic" title="${esc(c.topic)}">${esc(c.topic.replace(/-/g, ' '))}</span>`),
    kv('Type', esc(TYPE_LABEL[c.type])),
  ].join('');
  const gbrain = c.gbrain?.row !== undefined ? `GBrain take #${c.gbrain.row}` : c.gbrain?.page ? esc(c.gbrain.page) : '';
  return `<article class="${cls}"${id} data-claim-id="${esc(c.id)}">
<header class="r-head"><div class="r-id">${who}${sourceLine(c)}</div>${claimStamp(c, { fresh: opts.animate !== undefined })}</header>
<blockquote class="r-quote"${cite ? ` cite="${cite}"` : ''}><p>“${esc(c.quote)}”</p>${quoteFooter(c)}</blockquote>
<p class="r-claim"><span class="r-label">Claim</span>${esc(c.claim)}</p>
<dl class="r-kv">${rows}</dl>
${driftChip(c.drift, { withNote: true })}${verdictSection(c)}
<footer class="r-foot"><span>No. ${esc(c.id)}</span><span>${gbrain}</span></footer>
</article>`;
}

// ---- Page shell -------------------------------------------------------------

/** Kept for compatibility; pages no longer load web fonts (system fonts render with no network). */
export const FONTS_HREF = '';

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 20'%3E%3Cpath fill='%231b1a17' d='M1 1h14v16l-2.33 2-2.33-2L8 19l-2.33-2-2.33 2L1 17z'/%3E%3C/svg%3E";

export interface ShellOptions {
  title: string;
  description?: string;
  body: string;
  /** Link target for the wordmark. */
  home: string;
  nav?: { href: string; label: string }[];
  script?: string;
  /** CSP nonce for the inline script (live server). */
  nonce?: string;
  updated?: string;
  /** Live server: the live / offline badge in the masthead. */
  badge?: { mode: AppMode };
  /** Page-specific CSS appended after SITE_CSS. */
  extraCss?: string;
}

/** Where model answers come from: live with the key, recordings only, or recordings because there is no key. */
export type AppMode = 'live' | 'replay' | 'no-key';

export const MODE_BADGE: Record<AppMode, { label: string; title: string }> = {
  live: { label: 'Live', title: 'Live: searches the web and records answers so the demo can replay offline.' },
  replay: { label: 'Offline replay', title: 'Answers come from recordings in fixtures/llm. New searches are not possible.' },
  'no-key': { label: 'Offline: no API key', title: 'Add OPENAI_API_KEY to .env for live search. Recorded answers still work.' },
};

export function modeBadge(mode: AppMode): string {
  const b = MODE_BADGE[mode];
  return `<span class="badge badge-${mode}" title="${esc(b.title)}" id="mode-badge"><span class="dot" aria-hidden="true"></span>${esc(b.label)}<span class="vh">. ${esc(b.title)}</span></span>`;
}

/** Plain-language verdict words for first-time readers. */
export const PLAIN_VERDICT: Record<Verdict, string> = {
  correct: 'Came true',
  incorrect: 'Did not happen',
  partial: 'Partly',
  unresolvable: 'Could not be judged',
  too_early: 'Too early to tell',
  pending: 'Waiting on its deadline',
};

/** Person card record line: "4 of 13 came true, 1 partly · 8 waiting" (over predictions). */
export function recordLine(s: Pick<PersonScore, 'correct' | 'incorrect' | 'partial' | 'pending' | 'tooEarly' | 'claims'>): string {
  const g = s.correct + s.incorrect + s.partial;
  const w = s.pending + s.tooEarly;
  if (g > 0) return `${s.correct} of ${g} came true${s.partial > 0 ? `, ${s.partial} partly` : ''}${w > 0 ? ` · ${w} waiting` : ''}`;
  if (w > 0) return w === 1 ? '1 prediction waiting on its deadline' : `${w} predictions waiting on their deadline`;
  if (s.claims > 0) return `${plural(s.claims, 'statement')} on record, no predictions yet`;
  return 'No receipts yet';
}

export const CALIBRATION_NOTE = 'Calibration score: how well their confidence matched what happened. Lower is better; 0.25 is a coin flip.';

export function pageShell(o: ShellOptions): string {
  const nav = (o.nav ?? []).map((n) => `<a href="${esc(n.href)}">${esc(n.label)}</a>`).join('');
  const nonce = o.nonce ? ` nonce="${esc(o.nonce)}"` : '';
  const script = o.script ? `<script${nonce}>${o.script}</script>` : '';
  const updated = o.updated ? `<p>Ledger updated ${esc(fmtDate(o.updated.slice(0, 10)))}.</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(o.title)}</title>
${o.description ? `<meta name="description" content="${esc(o.description)}">` : ''}
<link rel="icon" href="${FAVICON}">
<style>${SITE_CSS}${o.extraCss ?? ''}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="mast"><div class="wrap mast-in">
<a class="brand" href="${esc(o.home)}"><span class="brand-mark" aria-hidden="true"></span>Receipts</a>
${nav ? `<nav class="mast-nav" aria-label="Sections">${nav}</nav>` : ''}
${o.badge ? modeBadge(o.badge.mode) : ''}
</div></header>
<main id="main" class="wrap">
${o.body}
</main>
<footer class="site-foot"><div class="wrap">
<p><strong>Track record on public statements.</strong> Verdicts are AI-assisted; every one links its evidence.</p>
${updated}
</div></footer>
${script}
</body>
</html>
`;
}

// ---- CSS --------------------------------------------------------------------

// Film-grain alpha mask for stamps: mostly opaque with small ink gaps, like a
// rubber stamp that did not quite take everywhere.
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='80'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='2' seed='7'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -3.2 2.45'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E\")";

const LIGHT = `
  --bg: #f3f0e8; --paper: #fffdf8; --paper-2: #f8f5ed;
  --ink: #1b1a17; --ink-2: #57534a; --ink-3: #6f6a5f;
  --rule: #ddd7c8; --rule-strong: #b3ab98;
  --accent: #2247a3; --focus: #2247a3;
  --v-correct: #17703a; --v-incorrect: #b8322a; --v-partial: #8e5b00;
  --v-open: #4d5b76; --v-unresolvable: #6b6b6b;`;

const DARK = `
  --bg: #131211; --paper: #1e1d1b; --paper-2: #252421;
  --ink: #ece8df; --ink-2: #b8b2a5; --ink-3: #979184;
  --rule: #34322d; --rule-strong: #57534a;
  --accent: #8fb0ff; --focus: #8fb0ff;
  --v-correct: #5cc98a; --v-incorrect: #ff7a6b; --v-partial: #e8b04a;
  --v-open: #9fb0cf; --v-unresolvable: #a3a3a3;`;

export const SITE_CSS = `
:root{${LIGHT}
  --font-display: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --font-body: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --grain: ${GRAIN};
  color-scheme: light;
}
@media (prefers-color-scheme: dark){ :root{${DARK} color-scheme: dark; } }
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:400 1rem/1.55 var(--font-body);overflow-wrap:break-word;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-underline-offset:.18em;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:2px}
h1,h2,h3{font-family:var(--font-display);line-height:1.1;letter-spacing:-.01em;margin:0}
code,.mono{font-family:var(--font-mono);font-size:.9em}
.vh{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.muted{color:var(--ink-3)}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
.skip{position:absolute;left:-999px;top:0;background:var(--ink);color:var(--paper);padding:.5rem .75rem;z-index:10}
.skip:focus{left:8px;top:8px}

/* masthead */
.mast{border-bottom:1px dashed var(--rule-strong)}
.mast-in{display:flex;align-items:center;justify-content:space-between;gap:.5rem 1.5rem;flex-wrap:wrap;padding-top:1rem;padding-bottom:1rem}
.brand{display:inline-flex;align-items:center;gap:.6rem;font:700 .95rem/1 var(--font-mono);letter-spacing:.22em;text-transform:uppercase;color:var(--ink);text-decoration:none}
.brand-mark{width:14px;height:18px;background:var(--ink);clip-path:polygon(0 0,100% 0,100% 84%,83% 100%,67% 84%,50% 100%,33% 84%,17% 100%,0 84%)}
.mast-nav{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;font:500 .78rem/1 var(--font-mono);letter-spacing:.06em;text-transform:uppercase}
.mast-nav a{color:var(--ink-2);text-decoration:none;padding:.35rem 0}
.mast-nav a:hover{color:var(--ink);text-decoration:underline}

/* hero */
.hero{padding:3.25rem 0 0}
.eyebrow{font:500 .74rem/1.4 var(--font-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin:0 0 1rem}
.hero h1{font-size:clamp(2.05rem,1.2rem + 3.4vw,3.7rem);font-weight:750;line-height:1.02;letter-spacing:-.025em;max-width:19ch}
.lede{font-size:1.1rem;color:var(--ink-2);max-width:62ch;margin:1.1rem 0 0}
.lede em{color:var(--ink)}
.lede code{white-space:nowrap}
.tape{display:flex;flex-wrap:wrap;margin:2rem 0 0;padding:0;border-top:1px dashed var(--rule-strong);border-bottom:1px dashed var(--rule-strong)}
.tape div{padding:.8rem 2rem .8rem 0}
.tape dt{font:500 .68rem/1.3 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}
.tape dd{margin:.15rem 0 0;font:700 1.6rem/1.1 var(--font-display);font-variant-numeric:tabular-nums}

/* sections */
.sec{margin-top:3.5rem}
.sec-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.35rem 1.5rem;border-bottom:2px solid var(--ink);padding-bottom:.55rem;margin-bottom:1.25rem}
.sec-head h2{font-size:1.55rem;font-weight:700}
.sec-head p{margin:0;font-size:.88rem;color:var(--ink-2);max-width:60ch}
.note{font-size:.85rem;color:var(--ink-2);margin:.75rem 0 0;max-width:80ch}
.empty{border:1.5px dashed var(--rule-strong);border-radius:4px;padding:1.25rem 1.4rem;color:var(--ink-2);background:var(--paper)}
.empty strong{color:var(--ink)}

/* tables */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;background:var(--paper);border:1px solid var(--rule);border-radius:4px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
caption{text-align:left}
th{font:600 .68rem/1.25 var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);text-align:right;padding:.8rem .9rem;border-bottom:1px solid var(--rule-strong);white-space:nowrap;vertical-align:bottom}
td{padding:.8rem .9rem;border-bottom:1px dashed var(--rule);text-align:right;white-space:nowrap;font:400 .9rem/1.3 var(--font-mono);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
th:first-child,td:first-child{text-align:left;position:sticky;left:0;background:var(--paper);z-index:1}
th[scope=row]{font:400 .9rem/1.3 var(--font-body);letter-spacing:0;text-transform:none;color:var(--ink);border-bottom:1px dashed var(--rule);padding:.8rem .9rem;vertical-align:middle}
tbody tr:last-child th{border-bottom:0}
td .sub{display:block;font-size:.72rem;color:var(--ink-3);margin-top:.15rem}
td.thin,td.thin .num-strong{color:var(--ink-3)}
.chip-by{font:500 .6rem/1 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);margin-left:.35rem;white-space:nowrap}
.who-cell{min-width:12.5rem}
.who{font:650 1.02rem/1.2 var(--font-display);color:var(--ink);text-decoration:none}
.who:hover{text-decoration:underline}
.who-cell .tally{margin-top:.45rem;max-width:11rem}
.num-strong{font-weight:700;color:var(--ink)}
.worse{color:var(--v-incorrect)}
.better{color:var(--v-correct)}
.topic{font-family:var(--font-mono)}

/* leaderboard: sized to read on a projector (headers 13px, cells 17px, darker greys) */
#leaderboard th{font-size:.8125rem;color:var(--ink-2)}
#leaderboard td{font-size:1.0625rem}
#leaderboard th[scope=row]{font-size:1.0625rem}
#leaderboard .who{font-size:1.2rem}
#leaderboard td .sub{font-size:.8125rem;color:var(--ink-2)}
#leaderboard td.thin,#leaderboard td.thin .num-strong{color:var(--ink-2)}
#leaderboard td.thin .sub{font-style:italic}

/* tally strip + legend */
.tally{display:flex;gap:2px;height:8px;width:100%}
.tally .t{min-width:3px}
.tally .t:first-child{border-radius:4px 0 0 4px}
.tally .t:last-child{border-radius:0 4px 4px 0}
.tally .t:only-child{border-radius:4px}
.tally-empty{border:1px dashed var(--rule-strong);border-radius:4px;display:block}
.t-correct{background:var(--v-correct)}
.t-incorrect{background:var(--v-incorrect)}
.t-partial{background:repeating-linear-gradient(-45deg,var(--v-partial) 0 2.5px,color-mix(in srgb,var(--v-partial) 40%,transparent) 2.5px 4.5px)}
.t-unresolvable{background:var(--v-unresolvable)}
.t-open{background:color-mix(in srgb,var(--v-open) 38%,transparent)}
.legend{display:flex;flex-wrap:wrap;gap:.35rem 1rem;list-style:none;margin:.6rem 0 0;padding:0;font:400 .72rem/1.4 var(--font-mono);color:var(--ink-2)}
.legend li{display:inline-flex;align-items:center;gap:.4rem}
.legend b{color:var(--ink);font-weight:600}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px}

/* stamps, tags, chips */
.stamp{--v:var(--v-open);display:inline-flex;flex-direction:column;align-items:center;gap:.1rem;color:var(--v);border:2px solid currentColor;box-shadow:inset 0 0 0 2px var(--paper),inset 0 0 0 3.5px currentColor;border-radius:4px;padding:.42rem .62rem .38rem;font:800 .8rem/1 var(--font-mono);letter-spacing:.14em;text-transform:uppercase;white-space:nowrap;transform:rotate(-4deg);-webkit-mask-image:var(--grain);mask-image:var(--grain);-webkit-mask-size:160px 80px;mask-size:160px 80px}
.stamp-sm{font-size:.62rem;padding:.28rem .42rem .25rem;border-width:1.5px;box-shadow:inset 0 0 0 1.5px var(--paper),inset 0 0 0 2.5px currentColor;transform:rotate(-3deg)}
.stamp-note{font-size:.58em;letter-spacing:.1em;font-weight:600}
.v-correct{--v:var(--v-correct)}
.v-incorrect{--v:var(--v-incorrect)}
.v-partial{--v:var(--v-partial)}
.v-unresolvable{--v:var(--v-unresolvable)}
.v-open{--v:var(--v-open)}
.tag{display:inline-block;font:600 .66rem/1 var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-2);border:1px solid var(--rule-strong);border-radius:999px;padding:.35rem .6rem;white-space:nowrap}
.tag-sm{font-size:.6rem;padding:.25rem .45rem}
.chip{display:inline-block;font:600 .64rem/1 var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-2);border:1px solid var(--rule-strong);border-radius:3px;padding:.3rem .45rem;white-space:nowrap;vertical-align:.1em}
.chip-notable{background:var(--ink);border-color:var(--ink);color:var(--paper)}

/* receipt card */
.receipt{position:relative;background:var(--paper);border:1.5px dashed var(--rule-strong);border-radius:3px;padding:1.1rem 1.25rem .9rem;min-width:0}
.r-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.5rem 1rem;align-items:start}
.r-head .stamp,.r-head .tag{margin-top:.2rem}
.r-who{display:block;font:700 1.08rem/1.2 var(--font-display);color:var(--ink);text-decoration:none;margin-bottom:.3rem}
.r-who:hover{text-decoration:underline}
.r-src time,.nw{white-space:nowrap}
.r-src{margin:0;font:500 .7rem/1.4 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.r-title{margin:.15rem 0 0;font-size:.9rem;line-height:1.35}
.r-title a{color:var(--ink-2)}
.r-quote{margin:1rem 0 .85rem;padding:0 0 0 .95rem;border-left:3px solid var(--v)}
.r-quote p{margin:0;font-style:italic;font-size:1.08rem;line-height:1.5;color:var(--ink)}
.r-quote footer{display:flex;flex-wrap:wrap;gap:.25rem 1rem;margin-top:.45rem;font:500 .74rem/1.4 var(--font-mono)}
.r-jump{text-decoration:none;color:var(--accent)}
.r-jump:hover{text-decoration:underline}
.r-unverified{color:var(--v-partial)}
.r-claim{margin:0 0 .9rem;font-size:.95rem;color:var(--ink-2)}
.r-label{display:inline-block;font:600 .64rem/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin-right:.55rem}
.r-kv{margin:0;padding:.7rem 0 0;border-top:1px dashed var(--rule-strong);font:400 .8rem/1.45 var(--font-mono);font-variant-numeric:tabular-nums}
.kv{display:flex;align-items:baseline;gap:.6ch;padding:.08rem 0}
.kv dt{flex:none;font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.kv .dots{flex:1 1 1rem;min-width:1rem;border-bottom:1.5px dotted var(--rule-strong);transform:translateY(-.3em)}
.kv dd{margin:0;text-align:right;color:var(--ink);min-width:0}
.kv .arrow{color:var(--ink-3)}
.r-drift{margin:.8rem 0 0;font-size:.85rem;color:var(--ink-2)}
.r-verdict{margin-top:.85rem;padding-top:.75rem;border-top:1px dashed var(--rule-strong)}
.r-rationale{margin:0;font-size:.92rem}
.r-evidence{margin:.6rem 0 0;padding-left:1.4rem;font-size:.84rem}
.r-evidence li{margin:.3rem 0;padding-left:.15rem}
.r-evidence li::marker{font:600 .75rem var(--font-mono);color:var(--ink-3)}
.ev-link{overflow-wrap:anywhere}
.ev-meta{display:block;font:400 .7rem/1.4 var(--font-mono);color:var(--ink-3)}
.r-evidence q{display:block;color:var(--ink-2);font-style:italic;margin-top:.1rem}
.r-meta{margin:.6rem 0 0;font:400 .7rem/1.5 var(--font-mono);color:var(--ink-3)}
.r-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.25rem 1rem;margin-top:.9rem;padding-top:.55rem;border-top:1px dashed var(--rule);font:400 .66rem/1.4 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.feed{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,21rem),1fr));gap:1.1rem;align-items:start;list-style:none;margin:0;padding:0}

/* person page */
.crumbs{margin:1.5rem 0 0;font:500 .78rem/1 var(--font-mono);letter-spacing:.06em;text-transform:uppercase}
.crumbs a{color:var(--ink-2);text-decoration:none}
.crumbs a:hover{color:var(--ink);text-decoration:underline}
.person-head{padding:1.75rem 0 0}
.person-head h1{font-size:clamp(2.3rem,1.5rem + 3.4vw,4rem);font-weight:750;letter-spacing:-.03em;line-height:1}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14.5rem),1fr));gap:1rem;margin-top:2rem}
.tile{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:1rem 1.1rem 1.05rem;min-width:0}
.tile-label{margin:0;font:600 .68rem/1.3 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}
.tile-value{margin:.4rem 0 .35rem;font:750 2.5rem/1 var(--font-display);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.tile-sub{margin:0;font-size:.86rem;color:var(--ink-2)}
.tile .tally{margin-top:.7rem}
.meter{position:relative;height:22px;margin-top:.7rem}
.meter-track{position:absolute;left:0;right:0;top:9px;height:4px;border-radius:4px;background:linear-gradient(90deg,color-mix(in srgb,var(--v-correct) 55%,transparent),color-mix(in srgb,var(--v-open) 25%,transparent) 25%,color-mix(in srgb,var(--v-incorrect) 45%,transparent))}
.meter-base{position:absolute;top:2px;width:2px;height:18px;background:var(--ink-2);transform:translateX(-1px)}
.meter-dot{position:absolute;top:4px;width:14px;height:14px;border-radius:50%;background:var(--ink);box-shadow:0 0 0 2px var(--paper);transform:translateX(-7px)}
.meter-scale{display:flex;justify-content:space-between;font:400 .66rem/1.3 var(--font-mono);color:var(--ink-3);margin-top:.25rem}
.split{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:1.25rem;align-items:start}
.split th,.split td{padding-left:.65rem;padding-right:.65rem}
.split h3{font-size:1rem;margin:0 0 .6rem}

/* drift chains */
.chains{display:grid;gap:1rem}
.chain{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:1rem 1.15rem 1.1rem;min-width:0}
.chain-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem 1rem}
.chain-head h3{font:600 .88rem/1.3 var(--font-mono);letter-spacing:.02em}
.chain-head h3 a{color:var(--ink)}
.chain-sum{margin:0;font-size:.86rem;color:var(--ink-2)}
.steps{display:flex;flex-wrap:wrap;align-items:stretch;row-gap:.75rem;list-style:none;margin:.9rem 0 0;padding:0}
.step{display:flex;align-items:stretch}
.step+.step::before{content:"→";align-self:center;padding:0 .55rem;color:var(--ink-3);font:400 1.1rem/1 var(--font-mono)}
.pill{display:flex;flex-direction:column;gap:.2rem;min-width:7.25rem;max-width:15rem;padding:.5rem .7rem .55rem;border:1.5px solid var(--rule-strong);border-left:4px solid var(--v);border-radius:4px;background:var(--bg)}
a.pill{color:inherit;text-decoration:none}
a.pill:hover{border-color:var(--ink);border-left-color:var(--v)}
.pill-said{font:500 .64rem/1.2 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.pill-due{font:750 1.3rem/1.05 var(--font-display);font-variant-numeric:tabular-nums}
.pill-due.nodate{font-size:1rem;color:var(--ink-2)}
.pill-v{font:600 .62rem/1.2 var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--v)}
.pill .chip{align-self:flex-start;margin-top:.15rem}
.pill-note{font-size:.76rem;line-height:1.35;color:var(--ink-2)}
.pill-by{font:500 .58rem/1.2 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}

/* timeline of receipts */
.timeline{list-style:none;margin:0;padding:0;display:grid;gap:2rem}
.year{display:grid;grid-template-columns:5.5rem minmax(0,1fr);gap:1.25rem;align-items:start}
.year-label{position:sticky;top:1rem;font:750 1.55rem/1 var(--font-display);color:var(--ink-3);font-variant-numeric:tabular-nums;padding-top:.25rem}
.year .cards{list-style:none;margin:0;padding:0;display:grid;gap:1rem;max-width:46rem}

/* method */
.method{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.25rem 2.5rem;align-items:start}
.method dl{margin:0}
.method dt{font:700 .95rem/1.3 var(--font-display);margin-top:.9rem}
.method dt:first-child{margin-top:0}
.method dd{margin:.2rem 0 0;color:var(--ink-2);font-size:.92rem}
.hedge-table td:first-child{font-weight:700}
.hedge-table td,.hedge-table th{white-space:normal;text-align:left}
.hedge-table td:first-child{width:4.5rem}

/* live workbench */
.bench{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:1.25rem;align-items:start;margin-top:2.5rem}
.panel{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:1.15rem 1.25rem 1.25rem;min-width:0}
.panel h2{font-size:1.25rem;font-weight:700}
.panel .hint{margin:.3rem 0 1rem;font-size:.88rem;color:var(--ink-2)}
.fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.85rem}
.field{display:grid;gap:.3rem;min-width:0}
.field.wide{grid-column:1/-1}
.field label{font:600 .68rem/1.2 var(--font-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-2)}
.field label span{color:var(--ink-3);font-weight:400;letter-spacing:.04em;text-transform:none}
input[type=text],input[type=date],input[type=search]{font:inherit;font-size:1rem;width:100%;min-width:0;padding:.6rem .7rem;color:var(--ink);background:var(--bg);border:1.5px solid var(--rule-strong);border-radius:4px}
input::placeholder{color:var(--ink-3)}
input:focus-visible{outline:2px solid var(--focus);outline-offset:1px;border-color:var(--focus)}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;margin-top:1rem}
.btn{font:700 .78rem/1 var(--font-mono);letter-spacing:.12em;text-transform:uppercase;padding:.85rem 1.15rem;border-radius:4px;border:1.5px solid var(--ink);background:var(--ink);color:var(--paper);cursor:pointer}
.btn:hover{background:transparent;color:var(--ink)}
.btn[disabled]{opacity:.55;cursor:progress}
.btn-quiet{text-align:left;line-height:1.35;background:transparent;color:var(--ink-2);border-color:var(--rule-strong);font-weight:500;letter-spacing:.04em;text-transform:none;font-family:var(--font-body);font-size:.84rem;padding:.45rem .7rem}
.btn-quiet:hover{color:var(--ink);border-color:var(--ink)}
.ask-row{display:flex;gap:.6rem}
.ask-row input{flex:1}
.suggest{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}
.status{font:400 .78rem/1.4 var(--font-mono);color:var(--ink-3)}
.log{list-style:none;margin:1rem 0 0;padding:.65rem .8rem;background:var(--bg);border:1px dashed var(--rule-strong);border-radius:4px;font:400 .76rem/1.5 var(--font-mono);max-height:16rem;overflow:auto}
.log li{display:grid;grid-template-columns:auto 6.5rem minmax(0,1fr);gap:.75ch;padding:.1rem 0}
.log time{color:var(--ink-3)}
.log .st{font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2)}
.log .st-verified,.log .st-complete{color:var(--v-correct)}
.log .st-graded{color:var(--v-open)}
.log .st-dropped{color:var(--ink-3)}
.log .st-error{color:var(--v-incorrect)}
.notice{margin:1rem 0 0;padding:.7rem .9rem;border-left:3px solid var(--v-open);background:var(--bg);font-size:.92rem}
.notice-error{border-left-color:var(--v-incorrect)}
.notice-ok{border-left-color:var(--v-correct)}
.answer{margin-top:1rem}
.answer p{margin:0 0 .6rem;font-size:.98rem;white-space:pre-line}
.answer p.status{font-size:.78rem;white-space:normal}
.mini{list-style:none;margin:.75rem 0 0;padding:0;display:grid;gap:.6rem}
.mini li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:.2rem .75rem;align-items:start;padding-top:.6rem;border-top:1px dashed var(--rule)}
.mini q{font-style:italic;font-size:.9rem}
.mini .mini-claim{margin:.2rem 0 0;font-size:.85rem;color:var(--ink-2)}
.mini .mini-meta{grid-column:2;font:400 .7rem/1.4 var(--font-mono);color:var(--ink-3)}
#live-feed[hidden],.log[hidden]{display:none}

/* footer */
.site-foot{margin-top:4.5rem;border-top:1px dashed var(--rule-strong);padding:1.5rem 0 2.5rem;font-size:.86rem;color:var(--ink-2)}
.site-foot p{margin:.2rem 0}

/* motion */
@keyframes slide-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes stamp-in{0%{opacity:0;transform:rotate(-4deg) scale(1.7)}65%{opacity:1;transform:rotate(-4deg) scale(.94)}100%{opacity:1;transform:rotate(-4deg) scale(1)}}
.receipt.is-new{animation:slide-in .5s cubic-bezier(.2,.7,.2,1) both}
.stamp.is-new{animation:stamp-in .42s .2s cubic-bezier(.3,.7,.3,1.2) both}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}

/* narrow screens */
/* 150% zoom on a 1280px projector leaves about 853 CSS px: keep all 7 leaderboard columns on screen */
@media (max-width: 960px){
  .who-cell{min-width:10rem}
  #leaderboard th,#leaderboard td{padding-left:.6rem;padding-right:.6rem}
}
@media (max-width: 860px){
  .bench,.split,.method{grid-template-columns:minmax(0,1fr)}
}
@media (max-width: 700px){
  .wrap{padding:0 16px}
  .hero{padding-top:2.25rem}
  .tape div{padding-right:1.4rem}
  .who-cell{min-width:9.5rem}
  .who-cell .tally{max-width:8.5rem}
  table .opt{display:none}
  #leaderboard td,#leaderboard th[scope=row]{font-size:.95rem}
  .sec{margin-top:2.75rem}
  .year{grid-template-columns:minmax(0,1fr);gap:.6rem}
  .year-label{position:static;border-bottom:1px dashed var(--rule-strong);padding-bottom:.4rem}
  .receipt{padding:1rem 1rem .85rem}
  .r-head{grid-template-columns:minmax(0,1fr)}
  .r-head .stamp,.r-head .tag{justify-self:start;grid-row:1}
  .fields{grid-template-columns:minmax(0,1fr)}
  .ask-row{flex-direction:column}
  .log li{grid-template-columns:auto minmax(0,1fr)}
  .log li .msg{grid-column:1/-1}
}
`;
