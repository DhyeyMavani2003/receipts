// Runtime configuration: environment variables + project paths.
// Bun loads .env from the working directory automatically, so this module
// only reads process.env. The OpenAI key is carried in the config but must
// never be printed; use redactedConfig() for anything user-facing.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Config {
  root: string;
  ledgerPath: string;
  seedPath: string;
  fixturesDir: string;
  outDir: string;
  gbrainBin: string;
  gbrainHome?: string;
  llmMode: 'openai' | 'replay';
  record: boolean;
  model?: string;
  graderModel?: string;
  openaiKey?: string;
  today: string;
}

export type Env = Record<string, string | undefined>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PATH_KEYS = ['root', 'ledgerPath', 'seedPath', 'fixturesDir', 'outDir'] as const;

/** Nearest directory at or above `start` that holds a package.json. */
export function findRoot(start: string = import.meta.dir): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(import.meta.dir, '..');
    dir = parent;
  }
}

/** Current UTC date as YYYY-MM-DD. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// .env.example ships keys with empty values; treat those as unset.
function envValue(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function parseLlmMode(raw: string | undefined): Config['llmMode'] {
  if (raw === undefined || raw === 'openai') return 'openai';
  if (raw === 'replay') return 'replay';
  throw new Error(`RECEIPTS_LLM must be "openai" or "replay" (got "${raw}")`);
}

function parseFlag(raw: string | undefined): boolean {
  return raw !== undefined && ['1', 'true', 'yes', 'on', 'force'].includes(raw.toLowerCase());
}

function parseToday(raw: string | undefined): string {
  if (raw === undefined) return utcToday();
  if (!DATE_RE.test(raw)) throw new Error(`RECEIPTS_TODAY must be YYYY-MM-DD (got "${raw}")`);
  return raw;
}

// Callers pass CLI flags straight through, so `{ today: undefined }` means "not given".
function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Build a Config from an explicit env map. loadConfig() is this over process.env. */
export function configFromEnv(env: Env, overrides: Partial<Config> = {}): Config {
  const o = definedOnly(overrides);
  const root = o.root ? resolve(o.root) : findRoot();
  const base: Config = {
    root,
    ledgerPath: join(root, 'data', 'ledger.json'),
    seedPath: join(root, 'data', 'seed', 'predictions.json'),
    fixturesDir: join(root, 'fixtures', 'llm'),
    outDir: join(root, 'out'),
    gbrainBin: envValue(env, 'GBRAIN_BIN') ?? 'gbrain',
    gbrainHome: envValue(env, 'GBRAIN_HOME'),
    llmMode: o.llmMode ?? parseLlmMode(envValue(env, 'RECEIPTS_LLM')),
    record: parseFlag(envValue(env, 'RECEIPTS_RECORD')),
    model: envValue(env, 'RECEIPTS_MODEL'),
    graderModel: envValue(env, 'RECEIPTS_GRADER_MODEL'),
    openaiKey: envValue(env, 'OPENAI_API_KEY'),
    today: o.today ?? parseToday(envValue(env, 'RECEIPTS_TODAY')),
  };
  const cfg: Config = { ...base, ...o, root };
  // Paths given as overrides (CLI flags) are relative to the working directory.
  for (const key of PATH_KEYS) cfg[key] = resolve(cfg[key]);
  if (!DATE_RE.test(cfg.today)) throw new Error(`today must be YYYY-MM-DD (got "${cfg.today}")`);
  return cfg;
}

export function loadConfig(overrides?: Partial<Config>): Config {
  return configFromEnv(process.env, overrides);
}

/** Copy safe to print or log: the key is reduced to whether it is set. */
export function redactedConfig(cfg: Config): Omit<Config, 'openaiKey'> & { openaiKey: 'set' | 'missing' } {
  return { ...cfg, openaiKey: cfg.openaiKey ? 'set' : 'missing' };
}
