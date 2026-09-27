#!/usr/bin/env bun
// A tiny stand-in for the gbrain CLI, for fast offline tests of the adapter's
// process plumbing and sync logic. State lives in $GBRAIN_HOME/fake-brain.json;
// every call also records its working directory and GBRAIN_HOME there. Only
// the commands and output formats src/gbrain.ts relies on are implemented.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Take {
  row_num: number;
  claim: string;
  kind: string;
  holder: string;
  weight: number;
  source: string | null;
  active: boolean;
  resolved_quality: string | null;
}

interface State {
  pages: Record<string, { content: string; revision: string }>;
  timeline: { page: string; date: string; summary?: string; detail?: string }[];
  takes: Record<string, Take[]>;
  calls: { args: string[]; cwd: string; home: string }[];
}

const args = Bun.argv.slice(2);
const home = process.env.GBRAIN_HOME ?? '';

function fail(code: string, message: string): never {
  console.error(`Error [${code}]: ${message}`);
  process.exit(1);
}

function flag(name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

if (args[0] === '--version') {
  console.log('gbrain 0.59.0 (fake)');
  process.exit(0);
}
if (!home || !existsSync(home)) fail('no_brain', 'No brain configured. Run gbrain init.');

const statePath = join(home, 'fake-brain.json');
const state: State = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, 'utf8')) as State)
  : { pages: {}, timeline: [], takes: {}, calls: [] };
state.calls.push({ args, cwd: process.cwd(), home });
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
save();

const [cmd, sub, page] = args;
if (cmd === 'get') {
  const p = state.pages[sub!];
  if (!p) fail('page_not_found', `page ${sub} not found`);
  console.log(JSON.stringify(p));
} else if (cmd === 'put') {
  const current = state.pages[sub!];
  const expected = flag('expected-revision');
  if (current && expected !== current.revision) fail('revision_conflict', 'revision changed');
  const content = await Bun.stdin.text();
  state.pages[sub!] = { content, revision: String(Number(current?.revision ?? 0) + 1) };
  save();
} else if (cmd === 'timeline-add') {
  if (!state.pages[sub!]) fail('page_not_found', `page ${sub} not found`);
  // Like gbrain 0.59: an entry is keyed by page, date and summary; an exact replay is skipped,
  // the same key with a different detail is rejected.
  const entry = { page: sub!, date: args[2]!, summary: flag('summary') ?? '', detail: flag('detail') ?? '' };
  const same = state.timeline.find((t) => t.page === entry.page && t.date === entry.date && (t.summary ?? '') === entry.summary);
  if (same && (same.detail ?? '') !== entry.detail) fail('invalid_params', 'This timeline identity already exists with different detail.');
  if (!same) state.timeline.push(entry);
  save();
} else if (cmd === 'takes' && sub === 'add') {
  if ((flag('claim') ?? '').includes('FAKE_GBRAIN_REJECT')) fail('invalid_params', 'rejected by the fake for a test');
  const rows = (state.takes[page!] ??= []);
  const row: Take = {
    row_num: rows.length + 1,
    claim: flag('claim') ?? '',
    kind: flag('kind') ?? '',
    holder: flag('who') ?? '',
    weight: Number(flag('weight')),
    source: flag('source') ?? null,
    active: true,
    resolved_quality: null,
  };
  rows.push(row);
  save();
  console.log(`Added take #${row.row_num} to ${page}.`);
} else if (cmd === 'takes' && sub === 'resolve') {
  const row = (state.takes[page!] ?? []).find((t) => t.row_num === Number(flag('row')));
  if (!row) fail('not_found', 'no such row');
  if (row.resolved_quality) fail('immutable', `take #${row.row_num} is already resolved; resolutions are immutable`);
  row.resolved_quality = flag('quality') ?? null;
  save();
} else if (cmd === 'takes' && sub === 'scorecard') {
  const rows = (state.takes[page!] ?? []).filter((t) => t.kind === 'bet');
  const correct = rows.filter((t) => t.resolved_quality === 'correct').length;
  const incorrect = rows.filter((t) => t.resolved_quality === 'incorrect').length;
  console.log(JSON.stringify({ total_bets: rows.length, correct, incorrect, accuracy: correct + incorrect ? correct / (correct + incorrect) : null }));
} else if (cmd === 'takes') {
  console.log(JSON.stringify(state.takes[sub!] ?? []));
} else {
  fail('unknown_command', `fake gbrain does not know "${args.join(' ')}"`);
}
