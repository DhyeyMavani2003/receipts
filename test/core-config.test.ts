import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configFromEnv, findRoot, redactedConfig, utcToday } from '../src/config.ts';

const ROOT = resolve(import.meta.dir, '..');

describe('config', () => {
  test('root is the directory holding package.json', () => {
    expect(findRoot()).toBe(ROOT);
    expect(existsSync(join(findRoot(), 'package.json'))).toBe(true);
  });

  test('defaults: paths under root, openai mode, today = UTC date', () => {
    const cfg = configFromEnv({});
    expect(cfg.root).toBe(ROOT);
    expect(cfg.ledgerPath).toBe(join(ROOT, 'data/ledger.json'));
    expect(cfg.seedPath).toBe(join(ROOT, 'data/seed/predictions.json'));
    expect(cfg.fixturesDir).toBe(join(ROOT, 'fixtures/llm'));
    expect(cfg.outDir).toBe(join(ROOT, 'out'));
    expect(cfg.gbrainBin).toBe('gbrain');
    expect(cfg.gbrainHome).toBeUndefined();
    expect(cfg.llmMode).toBe('openai');
    expect(cfg.record).toBe(false);
    expect(cfg.openaiKey).toBeUndefined();
    expect(cfg.today).toBe(utcToday());
  });

  test('reads env and treats empty values (as in .env.example) as unset', () => {
    const cfg = configFromEnv({
      OPENAI_API_KEY: 'sk-test-not-real',
      RECEIPTS_MODEL: '',
      RECEIPTS_GRADER_MODEL: 'gpt-5',
      RECEIPTS_LLM: 'replay',
      RECEIPTS_RECORD: '1',
      GBRAIN_BIN: '/root/.local/bin/gbrain',
      GBRAIN_HOME: '',
      RECEIPTS_TODAY: '2026-09-27',
    });
    expect(cfg.openaiKey).toBe('sk-test-not-real');
    expect(cfg.model).toBeUndefined();
    expect(cfg.graderModel).toBe('gpt-5');
    expect(cfg.llmMode).toBe('replay');
    expect(cfg.record).toBe(true);
    expect(cfg.gbrainBin).toBe('/root/.local/bin/gbrain');
    expect(cfg.gbrainHome).toBeUndefined();
    expect(cfg.today).toBe('2026-09-27');
  });

  test('overrides win, undefined overrides are ignored, relative paths resolve from cwd', () => {
    const cfg = configFromEnv(
      { RECEIPTS_TODAY: 'not-a-date', RECEIPTS_LLM: 'bogus' },
      { today: '2020-01-01', llmMode: 'replay', ledgerPath: 'tmp/l.json', model: undefined },
    );
    expect(cfg.today).toBe('2020-01-01');
    expect(cfg.llmMode).toBe('replay');
    expect(cfg.ledgerPath).toBe(resolve('tmp/l.json'));
  });

  test('root override moves the default paths with it', () => {
    const cfg = configFromEnv({}, { root: '/tmp/elsewhere' });
    expect(cfg.ledgerPath).toBe('/tmp/elsewhere/data/ledger.json');
    expect(cfg.outDir).toBe('/tmp/elsewhere/out');
  });

  test('bad RECEIPTS_LLM and RECEIPTS_TODAY fail loudly', () => {
    expect(() => configFromEnv({ RECEIPTS_LLM: 'claude' })).toThrow('RECEIPTS_LLM');
    expect(() => configFromEnv({ RECEIPTS_TODAY: '27/09/2026' })).toThrow('RECEIPTS_TODAY');
    expect(() => configFromEnv({}, { today: '2026-9-1' })).toThrow('YYYY-MM-DD');
  });

  test('redactedConfig never carries the key', () => {
    const cfg = configFromEnv({ OPENAI_API_KEY: 'sk-test-not-real' });
    const shown = JSON.stringify(redactedConfig(cfg));
    expect(shown).not.toContain('sk-test-not-real');
    expect(redactedConfig(cfg).openaiKey).toBe('set');
    expect(redactedConfig(configFromEnv({})).openaiKey).toBe('missing');
  });
});
