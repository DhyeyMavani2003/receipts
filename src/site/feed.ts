// "What's new" on the dashboard: new receipts, deadlines that just passed or
// are coming up, stories that moved, and fresh discoveries. Pure: everything
// comes from the ledger, the discoveries store, the watchlist and `today`.

import type { DiscoveryStore, Ledger, Watchlist } from '../types.ts';
import { topicLabel } from './render.ts';
import { DRIFT_LABEL_TEXT, NOTABLE_DRIFT, PLAIN_VERDICT, fmtDate, plural } from './theme.ts';

export type FeedKind = 'new_receipts' | 'came_due' | 'coming_due' | 'story_moved' | 'discovered';

export interface FeedItem {
  kind: FeedKind;
  date: string; // YYYY-MM-DD
  text: string;
  href: string;
  personSlug: string;
}

export const FEED_MAX = 8;

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function short(s: string, max = 90): string {
  const t = s.replace(/\s+/g, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => fmtDate(d)).trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function personHref(slug: string, anchor?: string): string {
  return `/p/${encodeURIComponent(slug)}${anchor ? `#${anchor}` : ''}`;
}

const KIND_ORDER: Record<FeedKind, number> = { came_due: 0, story_moved: 1, new_receipts: 2, discovered: 3, coming_due: 4 };

export function buildFeed(l: Ledger, d: DiscoveryStore, w: Watchlist, today: string): FeedItem[] {
  const items: FeedItem[] = [];
  const recentFrom = addDays(today, -30);

  // New receipts: one line per source pulled in the last 30 days.
  const bySource = new Map<string, { title: string; person: string; slug: string; n: number; date: string }>();
  for (const c of l.claims) {
    if (c.origin !== 'extracted' || !c.extractedAt) continue;
    const date = c.extractedAt.slice(0, 10);
    if (date <= recentFrom || date > today) continue;
    const key = `${c.personSlug}|${c.source.url || c.source.title}`;
    const cur = bySource.get(key);
    if (cur) {
      cur.n++;
      if (date > cur.date) cur.date = date;
    } else bySource.set(key, { title: c.source.title, person: c.person, slug: c.personSlug, n: 1, date });
  }
  for (const s of bySource.values()) {
    items.push({ kind: 'new_receipts', date: s.date, text: `${plural(s.n, 'new receipt')} from "${short(s.title, 70)}" (${s.person})`, href: personHref(s.slug, 'receipts'), personSlug: s.slug });
  }

  for (const c of l.claims) {
    if (c.type !== 'prediction' || !c.targetDate) continue;
    if (c.targetDate > recentFrom && c.targetDate <= today) {
      const outcome = c.verdict === 'pending' || c.verdict === 'too_early' ? 'Waiting to be graded.' : `${PLAIN_VERDICT[c.verdict]}.`;
      items.push({ kind: 'came_due', date: c.targetDate, text: `Deadline passed: "${short(c.claim)}" (${c.person}). ${outcome}`, href: personHref(c.personSlug, `c-${c.id}`), personSlug: c.personSlug });
    } else if (c.targetDate > today && c.targetDate <= addDays(today, 31) && (c.verdict === 'pending' || c.verdict === 'too_early')) {
      items.push({ kind: 'coming_due', date: c.targetDate, text: `Due ${fmtDate(c.targetDate)}: "${short(c.claim)}" (${c.person})`, href: personHref(c.personSlug, `c-${c.id}`), personSlug: c.personSlug });
    }
  }

  const yearAgo = addDays(today, -365);
  for (const c of l.claims) {
    if (!c.drift || !NOTABLE_DRIFT.has(c.drift.label)) continue;
    const fresh = (c.extractedAt && c.extractedAt.slice(0, 10) > recentFrom) || (c.saidDate > yearAgo && c.saidDate <= today);
    if (!fresh) continue;
    items.push({
      kind: 'story_moved',
      date: c.saidDate,
      text: `${c.person}: ${DRIFT_LABEL_TEXT[c.drift.label].toLowerCase()} on ${topicLabel(c.topic)}. ${short(c.drift.note, 110)}`,
      href: personHref(c.personSlug, 'moved'),
      personSlug: c.personSlug,
    });
  }

  const names = new Map(w.people.map((p) => [p.slug, p.name]));
  for (const [slug, rec] of Object.entries(d.bySlug)) {
    const n = rec.candidates.filter((c) => c.status === 'new').length;
    if (!n) continue;
    const name = names.get(slug) ?? l.claims.find((c) => c.personSlug === slug)?.person ?? slug;
    items.push({ kind: 'discovered', date: rec.checkedAt.slice(0, 10), text: `Found ${plural(n, 'new appearance')} for ${name}`, href: personHref(slug, 'appearances'), personSlug: slug });
  }

  return items
    .sort((a, b) => b.date.localeCompare(a.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.text.localeCompare(b.text))
    .slice(0, FEED_MAX);
}
