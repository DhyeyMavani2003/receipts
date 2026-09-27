// River SFT export: graded claims with evidence as chat-format JSONL, to
// fine-tune a small open model as your own grader. The fine-tuned model sees
// what our graders saw minus the web: the claim plus evidence snippets.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Claim, Ledger } from './types.ts';

export const GRADER_BRIEF = `You grade one public prediction for a neutral track record of public statements, using only the evidence provided.
Verdicts: correct (it happened by the deadline), incorrect (it did not, or the opposite happened), partial (materially mixed: a substantial part happened and a substantial part did not), unresolvable (too vague, or the evidence is inadequate or conflicting).
The speaker's own later claims of success are not evidence. Prefer evidence dated after the deadline. Never speculate beyond the evidence.
Reply with JSON only: {"verdict": "...", "confidence": 0-1, "rationale": "1-3 neutral sentences with dates and numbers", "resolvedOn": "YYYY-MM-DD" or null}.
resolvedOn is the date the outcome actually happened, even if after the deadline.`;

const TRAINABLE = new Set(['correct', 'incorrect', 'partial', 'unresolvable']);

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface RiverExample {
  messages: [ChatMessage, ChatMessage, ChatMessage];
}

/** The grader's input: claim, deadline and evidence snippets. */
export function graderInput(c: Claim): string {
  const evidence = (c.grading?.evidence ?? []).map((e, i) => {
    const head = `[${i + 1}] ${e.title ?? e.url}${e.date ? ` (${e.date})` : ''} ${e.url}`;
    return e.snippet ? `${head}\n    ${e.snippet}` : head;
  });
  return [
    `Speaker: ${c.person}`,
    `Said: ${c.saidDate} in "${c.source.title}" ${c.source.url}`,
    `Quote: "${c.quote}"`,
    `Claim (${c.type}): ${c.claim}`,
    `Deadline: ${c.targetDate ?? 'none stated'}`,
    `Resolution criteria: ${c.resolutionCriteria || 'not stated'}`,
    '',
    'Evidence:',
    ...evidence,
  ].join('\n');
}

/**
 * One training example, or null when the claim has no final verdict with
 * evidence. Disputed gradings are left out: their rationale is about the
 * judges' vote, which a single grader should never learn to cite.
 */
export function riverExample(c: Claim): RiverExample | null {
  const g = c.grading;
  if (!g || !TRAINABLE.has(g.verdict) || g.evidence.length === 0 || g.disputed) return null;
  const answer = { verdict: g.verdict, confidence: g.confidence, rationale: g.rationale, resolvedOn: g.resolvedOn ?? null };
  return {
    messages: [
      { role: 'system', content: GRADER_BRIEF },
      { role: 'user', content: graderInput(c) },
      { role: 'assistant', content: JSON.stringify(answer) },
    ],
  };
}

function byPersonDateId(a: Claim, b: Claim): number {
  return a.personSlug.localeCompare(b.personSlug) || a.saidDate.localeCompare(b.saidDate) || a.id.localeCompare(b.id);
}

/** JSONL lines for every exportable claim, in ledger order (person, date, id). */
export function riverLines(l: Ledger): string[] {
  return [...l.claims]
    .sort(byPersonDateId)
    .flatMap((c) => {
      const ex = riverExample(c);
      return ex ? [JSON.stringify(ex)] : [];
    });
}

/** Write the River SFT file (JSONL, one chat per line). Returns the number of examples. */
export function exportRiverSFT(l: Ledger, path: string): number {
  const lines = riverLines(l);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.length > 0 ? `${lines.join('\n')}\n` : '');
  return lines.length;
}
