// The CLI: argument parsing and formatting helpers in-process, then a few
// commands end to end as subprocesses against a temp ledger (offline replay,
// no gbrain binary, no key).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMANDS,
  UsageError,
  colorEnabled,
  displayPath,
  driftWarningReason,
  parityLine,
  leaderboardLines,
  loadRootEnv,
  parseArgs,
  parseDotEnv,
  receiptLines,
  serveNoKeyWarning,
  usage,
} from '../src/cli.ts';
import { scorePerson } from '../src/score.ts';
import { makeClaim } from './core-fixtures.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');

describe('parseArgs', () => {
  const spec = { speaker: 'string', 'no-gbrain': 'boolean', json: 'boolean' } as const;

  test('positionals, --flag value, --flag=value and booleans', () => {
    expect(parseArgs(['ingest', 'ep.txt', '--speaker', 'Dana Founder', '--no-gbrain'], spec)).toEqual({
      positionals: ['ingest', 'ep.txt'],
      flags: { speaker: 'Dana Founder', 'no-gbrain': true },
    });
    expect(parseArgs(['--speaker=Sam', 'x'], spec).flags.speaker).toBe('Sam');
  });

  test('-- ends options and -h means help', () => {
    expect(parseArgs(['ask', '--', '--json is not a flag here'], spec).positionals).toEqual(['ask', '--json is not a flag here']);
    expect(parseArgs(['-h'], spec).flags.help).toBe(true);
  });

  test('unknown flags, missing values and values on booleans are usage errors', () => {
    expect(() => parseArgs(['--speakr', 'x'], spec)).toThrow(UsageError);
    expect(() => parseArgs(['--speaker'], spec)).toThrow('--speaker needs a value');
    expect(() => parseArgs(['--speaker', '--json'], spec)).toThrow('--speaker needs a value');
    expect(() => parseArgs(['--json=yes'], spec)).toThrow('--json takes no value');
  });

  test('an optional-value flag may stand alone (export --river uses its default path then)', () => {
    const opt = { river: 'optional', json: 'boolean' } as const;
    expect(parseArgs(['export', '--river'], opt).flags.river).toBe(true);
    expect(parseArgs(['export', '--river', '--json'], opt).flags).toEqual({ river: true, json: true });
    expect(parseArgs(['export', '--river', 'out/x.jsonl'], opt).flags.river).toBe('out/x.jsonl');
    expect(parseArgs(['export', '--river=out/y.jsonl'], opt).flags.river).toBe('out/y.jsonl');
  });
});

describe('displayPath', () => {
  test('relative inside the working directory, ~ inside home, else unchanged', () => {
    expect(displayPath('/Users/a/receipts/data/ledger.json', '/Users/a/receipts', '/Users/a')).toBe('data/ledger.json');
    expect(displayPath('/Users/a/receipts', '/Users/a/receipts', '/Users/a')).toBe('.');
    expect(displayPath('/Users/a/receipts/data/ledger.json', '/tmp', '/Users/a')).toBe('~/receipts/data/ledger.json');
    expect(displayPath('/opt/x/ledger.json', '/tmp', '/Users/a')).toBe('/opt/x/ledger.json');
  });
});

describe('.env handling', () => {
  test('parseDotEnv reads KEY=VALUE lines, quotes, export and comments', () => {
    const env = parseDotEnv('# comment\nA=1\nexport B="two words"\nC=\'x # y\'\nD=plain # trailing\n\nnot a line\nE=');
    expect(env).toEqual({ A: '1', B: 'two words', C: 'x # y', D: 'plain', E: '' });
  });

  test('loadRootEnv fills only variables that are not set at all, and reports names only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipts-env-'));
    try {
      writeFileSync(join(dir, '.env'), 'FROM_FILE=file\nALREADY=file\nEMPTY_WINS=file\n');
      const env: Record<string, string | undefined> = { ALREADY: 'shell', EMPTY_WINS: '' };
      expect(loadRootEnv(dir, env)).toEqual(['FROM_FILE']);
      expect(env).toEqual({ ALREADY: 'shell', EMPTY_WINS: '', FROM_FILE: 'file' });
      expect(loadRootEnv(join(dir, 'missing'), env)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('serve without a key', () => {
  test('the warning says what breaks and suggests --offline', () => {
    expect(serveNoKeyWarning()).toContain('no OPENAI_API_KEY');
    expect(serveNoKeyWarning()).toContain('receipts serve --offline');
  });
});

describe('terminal formatting', () => {
  test('color follows NO_COLOR, --no-color, TTY and FORCE_COLOR', () => {
    expect(colorEnabled({}, true, false)).toBe(true);
    expect(colorEnabled({ NO_COLOR: '' }, true, false)).toBe(false);
    expect(colorEnabled({}, true, true)).toBe(false);
    expect(colorEnabled({}, false, false)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: '1' }, false, false)).toBe(true);
  });

  test('a receipt shows verdict, dates, hedge probability, quote, claim and link', () => {
    const c = makeClaim({ verdict: 'incorrect', hedge: 'for sure', impliedProbability: 0.95, quote: 'next year for sure' });
    const lines = receiptLines(c);
    expect(lines[0]).toBe('INCORRECT    2019-04-22 · due 2020-12-31 · "for sure" p=0.95 · tesla-robotaxi');
    expect(lines[1]).toBe('    “next year for sure”');
    expect(lines.at(-1)).toBe('    https://example.com/ep');
  });

  test('leaderboard has a header and one aligned row per person', () => {
    const s = scorePerson([makeClaim({ verdict: 'correct' }), makeClaim({ claim: 'Other', verdict: 'incorrect' })]);
    const [header, row] = leaderboardLines([s]);
    expect(header).toContain('Brier');
    expect(row).toContain('Elon Musk');
    expect(row).toContain('1/1/0');
    expect(row).toContain('50%');
  });

  test('the GBrain parity line rounds both sides to 3 decimals', () => {
    expect(parityLine(0.25, 0.4354545454545455, 12)).toBe(parityLine(0.25, 0.4354545396024534, 12));
    expect(parityLine(0.25, 0.4354545454545455, 12)).toBe('accuracy 0.250 · Brier 0.435 · 12 bets');
    expect(parityLine(null, undefined, undefined)).toBe('accuracy n/a · Brier n/a · n/a bets');
  });

  test('drift warnings are summarized without the fixture path', () => {
    const w = 'drift: kept deterministic labels for dana-founder/robot-tax: No replay fixture for drift_labels: /x/fixtures/llm/drift_labels-abc.json is missing. Record it with RECEIPTS_RECORD=1 and a live key.';
    expect(driftWarningReason(w)).toBe('dana-founder/robot-tax: no replay fixture for this chain (record one with RECEIPTS_RECORD=1)');
    expect(driftWarningReason('something else')).toBe('something else');
  });

  test('usage lists every command', () => {
    const text = usage();
    for (const name of ['doctor', 'seed', 'ingest', 'grade', 'drift', 'score', 'sync', 'site', 'serve', 'ask', 'export', 'demo']) {
      expect(COMMANDS[name]).toBeDefined();
      expect(text).toContain(`  ${name}`);
    }
  });
});

// ---- Subprocess runs ---------------------------------------------------------------

let dir: string;
let ledger: string;

// OPENAI_API_KEY is set to empty so the CLI never picks up a real key from the repo .env.
function runWith(llmMode: 'replay' | 'openai', args: string[]): { code: number; stdout: string; stderr: string } {
  const offline = llmMode === 'replay' ? ['--offline'] : [];
  const r = Bun.spawnSync(['bun', CLI, '--ledger', ledger, ...offline, '--today', '2026-09-27', ...args], {
    cwd: dir,
    env: { ...process.env, OPENAI_API_KEY: '', RECEIPTS_LLM: llmMode, RECEIPTS_RECORD: '0', NO_COLOR: '1', GBRAIN_BIN: join(dir, 'no-gbrain-here') },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function run(...args: string[]) {
  return runWith('replay', args);
}

describe('receipts CLI (subprocess, offline)', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'receipts-cli-'));
    ledger = join(dir, 'ledger.json');
    expect(run('seed').code).toBe(0);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('seed loads every seed claim and warns that gbrain is missing', () => {
    const l = JSON.parse(readFileSync(ledger, 'utf8'));
    const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'seed', 'predictions.json'), 'utf8'));
    expect(l.claims.length).toBe(seed.claims.length);
    const again = run('seed', '--no-gbrain');
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('0 new, 0 updated');
  });

  test('doctor passes offline, reports the key as missing and never prints a value', () => {
    const r = run('doctor');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OpenAI key\s+missing \(not needed in replay mode\)/);
    expect(r.stdout).toMatch(/warn\s+gbrain/);
  });

  test('doctor fails in live mode without a key, before any network call', () => {
    const r = runWith('openai', ['doctor']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+OpenAI key\s+missing: add OPENAI_API_KEY to \.env/);
    expect(r.stdout).toMatch(/FAIL\s+model\s+no key/);
  });

  test('live commands without a key say how to fix it', () => {
    const r = runWith('openai', ['ingest', join(ROOT, 'fixtures', 'transcripts', 'synthetic-interview.txt'), '--speaker', 'Dana Founder', '--url', 'https://example.com/synthetic-interview', '--no-gbrain']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('OPENAI_API_KEY missing');
    expect(r.stderr).toContain('--offline');
  });

  test('score --json matches score.ts for one person', () => {
    const r = run('score', '--person', 'elon-musk', '--json');
    expect(r.code).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(s.personSlug).toBe('elon-musk');
    expect(s.predictions).toBe(13);
    expect(run('score', '--person', 'nobody-here').code).toBe(1);
  });

  test('drift uses the seed drift fixtures offline', () => {
    const r = run('drift', '--no-gbrain');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Goalposts moved');
    const l = JSON.parse(readFileSync(ledger, 'utf8'));
    expect(l.claims.every((c: { drift?: unknown }) => c.drift)).toBe(true);
  });

  test('site, export and ask work from the ledger', () => {
    expect(run('site', '--out', join(dir, 'site')).code).toBe(0);
    expect(existsSync(join(dir, 'site', 'people', 'elon-musk.html'))).toBe(true);
    const exp = run('export', '--river', join(dir, 'river.jsonl'));
    expect(exp.code).toBe(0);
    expect(readFileSync(join(dir, 'river.jsonl'), 'utf8').trim().split('\n').length).toBeGreaterThan(20);
    const ask = run('ask', 'How much should I trust Elon Musk on robotaxis?');
    expect(ask.code).toBe(0);
    expect(ask.stdout).toContain('Receipts on robotaxis:');
    expect(ask.stdout).toContain('offline template');
  });

  test('ingest --dry-run replays the synthetic interview without writing', () => {
    const before = readFileSync(ledger, 'utf8');
    const r = run(
      'ingest', join(ROOT, 'fixtures', 'transcripts', 'synthetic-interview.txt'),
      '--speaker', 'Dana Founder', '--host', 'Sam Host', '--title', 'Synthetic Interview (test fixture)',
      '--date', '2025-01-15', '--url', 'https://example.com/synthetic-interview', '--dry-run',
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('16 claims verified, 0 dropped');
    expect(r.stdout).toContain('Dry run');
    expect(readFileSync(ledger, 'utf8')).toBe(before);
  });

  test('friendly usage errors exit 1', () => {
    const noSpeaker = run('ingest', 'x.txt');
    expect(noSpeaker.code).toBe(1);
    expect(noSpeaker.stderr).toContain('--speaker "Full Name" is required');
    expect(noSpeaker.stderr).toContain('Usage: receipts ingest');
    expect(run('frobnicate').stderr).toContain('Unknown command "frobnicate"');
    expect(run('score', '--speaker', 'x').stderr).toContain('"receipts score" has no --speaker option');
    expect(run('ingest', 'x.txt', '--speaker', 'A', '--date', '2024-13-45').stderr).toContain('--date must be a date');
  });

  test('a missing replay fixture is a clear error that names the fix', () => {
    const t = join(dir, 'other.txt');
    writeFileSync(t, 'Pat Guest: We will ship a million units next year.\n');
    const r = run('ingest', t, '--speaker', 'Pat Guest', '--date', '2025-01-01', '--url', 'https://example.com/other', '--no-gbrain');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No replay fixture for extract_claims');
    expect(r.stderr).toContain('RECEIPTS_RECORD=1');
    expect(r.stderr).not.toContain('pass --offline');
    expect(r.stderr).not.toContain(ROOT);
  });

  test('the recorded episode with one field changed names that field', () => {
    const r = run('ingest', join(ROOT, 'fixtures', 'transcripts', 'synthetic-interview.txt'), '--speaker', 'Dana Founder', '--title', 'Synthetic Interview (test fixture)',
      '--date', '2025-01-15', '--url', 'https://example.com/synthetic-interview', '--no-gbrain', '--no-grade');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('differs in Host: recorded "Sam Host", this request "not named');
  });

  test('a local file without --url is refused before anything runs', () => {
    const r = run('ingest', join(dir, 'other.txt'), '--speaker', 'Pat Guest', '--no-gbrain');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('needs its source link');
  });
});
