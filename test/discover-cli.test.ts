// CLI: follow, unfollow, discover --offline and watch against a temp ledger,
// in-process through main(). No model, network or gbrain.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COMMANDS, candidateLines, duePeople, main, parseEvery } from '../src/cli.ts';
import { loadWatchlist, watchlistPath } from '../src/watchlist.ts';

const dir = mkdtempSync(join(tmpdir(), 'receipts-discover-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let logs: string[] = [];
let errors: string[] = [];
const origLog = console.log;
const origError = console.error;
// main() loads the repo .env into process.env for keys not set yet; undo that so no other test file sees them.
let envBefore = new Set<string>();
beforeEach(() => {
  envBefore = new Set(Object.keys(process.env));
  logs = [];
  errors = [];
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  console.error = (...a: unknown[]) => errors.push(a.join(' '));
});
afterEach(() => {
  console.log = origLog;
  console.error = origError;
  for (const k of Object.keys(process.env)) if (!envBefore.has(k)) delete process.env[k];
});

function ledgerIn(name: string): string {
  return join(mkdtempSync(join(dir, `${name}-`)), 'ledger.json');
}

describe('commands are registered with --help', () => {
  test.each(['follow', 'unfollow', 'discover', 'watch'])('%s', async (name) => {
    expect(COMMANDS[name]).toBeDefined();
    expect(await main([name, '--help', '--no-color'])).toBe(0);
    expect(logs.join('\n')).toContain(`Usage: receipts ${name}`);
  });
});

describe('follow / unfollow', () => {
  test('follow, follow again, unfollow, unfollow again', async () => {
    const ledger = ledgerIn('f');
    expect(await main(['follow', 'lisa', 'su', '--ledger', ledger, '--no-color'])).toBe(0);
    expect(logs).toContain('Following Lisa Su.');
    expect(loadWatchlist(watchlistPath(ledger)).people.map((p) => p.slug)).toEqual(['lisa-su']);
    expect(await main(['follow', 'Lisa Su', '--ledger', ledger, '--no-color'])).toBe(0);
    expect(logs).toContain('Already following Lisa Su.');
    expect(await main(['unfollow', 'lisa-su', '--ledger', ledger, '--no-color'])).toBe(0);
    expect(logs).toContain('No longer following Lisa Su.');
    expect(await main(['unfollow', 'Lisa Su', '--ledger', ledger, '--no-color'])).toBe(1);
    expect(logs).toContain('Not following Lisa Su.');
  });

  test('a name is required', async () => {
    expect(await main(['follow', '--ledger', ledgerIn('n'), '--no-color'])).toBe(1);
    expect(errors.join('\n')).toContain('Give a name');
  });
});

describe('discover --offline', () => {
  test('no recording: a plain explanation, exit 1, the person is still followed', async () => {
    const ledger = ledgerIn('d');
    const code = await main(['discover', 'Receipts Test Person', '--offline', '--today', '2026-09-27', '--ledger', ledger, '--no-color']);
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('there is no recording of a search for Receipts Test Person');
    expect(loadWatchlist(watchlistPath(ledger)).people.map((p) => p.name)).toEqual(['Receipts Test Person']);
  });

  test('no name and nobody followed is a usage error', async () => {
    expect(await main(['discover', '--offline', '--ledger', ledgerIn('e'), '--no-color'])).toBe(1);
    expect(errors.join('\n')).toContain('not following anyone');
  });

  test('bad flags', async () => {
    expect(await main(['discover', 'X Y', '--limit', '11', '--offline', '--ledger', ledgerIn('b'), '--no-color'])).toBe(1);
    expect(await main(['watch', '--every', '10m', '--offline', '--ledger', ledgerIn('w'), '--no-color'])).toBe(1);
  });
});

describe('helpers', () => {
  test('parseEvery', () => {
    expect(parseEvery('24h')).toBe(86_400_000);
    expect(parseEvery('90m')).toBe(5_400_000);
    expect(parseEvery('2d')).toBe(172_800_000);
    expect(() => parseEvery('30m')).toThrow(/at least 1h/);
    expect(() => parseEvery('soon')).toThrow(/24h/);
  });

  test('duePeople: never checked first, recent skipped, at most 10', () => {
    const now = new Date('2026-09-27T12:00:00Z');
    const people = [
      { name: 'A', slug: 'a', followedAt: '', lastCheckedAt: '2026-09-27T11:00:00Z' },
      { name: 'B', slug: 'b', followedAt: '', lastCheckedAt: '2026-09-25T11:00:00Z' },
      { name: 'C', slug: 'c', followedAt: '' },
    ];
    expect(duePeople(people, 86_400_000, now).map((p) => p.slug)).toEqual(['c', 'b']);
    const many = Array.from({ length: 15 }, (_, i) => ({ name: `P${i}`, slug: `p${i}`, followedAt: '' }));
    expect(duePeople(many, 3_600_000, now)).toHaveLength(10);
  });

  test('candidateLines', () => {
    const lines = candidateLines(1, {
      title: 'AI factories',
      show: 'All-In Podcast',
      date: '2026-09-06',
      url: 'https://youtu.be/abcdefghijk',
      kind: 'podcast',
      durationMin: 58,
      transcriptSource: 'youtube',
      why: 'Export rules.',
      linkConfirmed: false,
    });
    expect(lines[0]).toBe('1. 2026-09-06 · 58 min · All-In Podcast · AI factories');
    expect(lines[1]).toBe('   https://youtu.be/abcdefghijk');
    expect(lines[2]).toBe('   Export rules. (link not confirmed by search)');
  });
});
