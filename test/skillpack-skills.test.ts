import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  PACK_ROOT,
  commandsFor,
  flagsOf,
  loadSkills,
  normalizeText,
  packFileExists,
  parseHedgeTable,
  readManifest,
  readPackFile,
  section,
  type SkillDoc,
} from './skillpack-helpers.ts';

const manifest = readManifest();
const skills = loadSkills();

// hedge.ts anchors. The 0.85 row is the plain future declarative,
// probed with "will", "is going to" and the empty hedge.
const HEDGE_TABLE: { p: number; cell: string; probes: string[] }[] = [
  { p: 0.95, cell: "for sure, definitely, certainly, guarantee, 100%, no doubt, absolutely, without question, completely obvious", probes: ["for sure", "definitely", "certainly", "guarantee", "100%", "no doubt", "absolutely", "without question", "completely obvious"] },
  { p: 0.9, cell: "very confident, highly confident, extremely likely, I'm confident, feel confident", probes: ["very confident", "highly confident", "extremely likely", "I'm confident", "feel confident"] },
  { p: 0.85, cell: "plain future declarative: will, is going to, or no hedge at all", probes: ["will", "is going to", ""] },
  { p: 0.75, cell: "very likely, expect, on track, fairly confident, the plan is, game plan", probes: ["very likely", "expect", "on track", "fairly confident", "the plan is", "game plan"] },
  { p: 0.7, cell: "likely, probably, should", probes: ["likely", "probably", "should"] },
  { p: 0.65, cell: "I think, I believe, my guess, I'm guessing, I guess", probes: ["I think", "I believe", "my guess", "I'm guessing", "I guess"] },
  { p: 0.55, cell: "I hope, hopefully, our hope is, aim to, goal is, aspirational, see if we can", probes: ["I hope", "hopefully", "our hope is", "aim to", "goal is", "aspirational", "see if we can"] },
  { p: 0.5, cell: "50/50, coin flip, maybe", probes: ["50/50", "coin flip", "maybe"] },
  { p: 0.4, cell: "possibly, potentially, could, might, we may, it may, may see", probes: ["possibly", "potentially", "could", "might", "we may", "it may", "may see"] },
  { p: 0.25, cell: "unlikely, doubt (about the event; a claim written as \"X will not\" gets 1 − p)", probes: ["unlikely", "doubt"] },
  { p: 0.1, cell: "no chance, never going to (about the event; a claim written as \"X will not\" gets 1 − p)", probes: ["no chance", "never going to"] },
];

// cli.ts contract: command → allowed flags (globals added below).
const RECEIPTS_CLI: Record<string, string[]> = {
  doctor: [],
  seed: ['--file', '--no-gbrain'],
  ingest: ['--speaker', '--host', '--title', '--date', '--url', '--kind', '--dry-run', '--no-gbrain', '--no-grade'],
  grade: ['--person', '--limit', '--judges', '--regrade', '--no-gbrain'],
  drift: ['--person', '--no-llm'],
  score: ['--person', '--json'],
  sync: ['--person'],
  site: ['--out'],
  serve: ['--port'],
  ask: [],
  export: ['--river'],
  demo: ['--live', '--speaker'],
};
const RECEIPTS_GLOBAL_FLAGS = ['--ledger', '--offline', '--today'];

// gbrain subcommands the manual paths may use (verified against gbrain 0.59).
const GBRAIN_SUBCOMMANDS = ['get', 'put', 'search', 'timeline', 'timeline-add', 'takes', 'upgrade'];
const TAKES_SUBCOMMANDS = ['add', 'resolve', 'scorecard', 'calibration', 'search'];
const GBRAIN_WRITES = /gbrain (put|timeline-add|takes (add|resolve|update|supersede))\b/;

const REQUIRED_SECTIONS = ['Non-negotiables', 'Hedge → probability table', 'Decide the path',
  'Fast path: the Receipts engine', 'Manual path: GBrain tools only', 'Output format', 'Anti-patterns'];

function gbrainCommands(skill: SkillDoc): string[] {
  return commandsFor(skill.body, 'gbrain');
}

describe.each(skills.map((s) => [s.slug, s] as const))('%s SKILL.md', (_slug, skill) => {
  const fm = skill.frontmatter;

  test('frontmatter has name, description, mutating and >= 5 triggers', () => {
    expect(fm.name).toBe(skill.slug);
    expect(fm.version).toBe(manifest.version);
    expect(typeof fm.description).toBe('string');
    expect(fm.description.trim().length).toBeGreaterThan(40);
    expect(typeof fm.mutating).toBe('boolean');
    expect(Array.isArray(fm.triggers)).toBe(true);
    expect(fm.triggers.length).toBeGreaterThanOrEqual(5);
    for (const trigger of fm.triggers) expect(normalizeText(trigger).length).toBeGreaterThanOrEqual(3);
  });

  test('body has every required section', () => {
    for (const title of REQUIRED_SECTIONS) expect(section(skill.body, title)).not.toBe('');
  });

  test('states all six non-negotiables', () => {
    const rules = section(skill.body, 'Non-negotiables');
    expect(rules).toContain('**Verbatim quote + link on every claim');
    expect(rules).toContain('**Holder = the speaker, not the subject.**');
    expect(rules).toContain('**Hedge → probability');
    expect(rules).toContain('**Independent evidence only');
    expect(rules).toContain('**Neutral tone.**');
    expect(rules).toContain('**Unresolvable is allowed');
  });

  test('carries the hedge table verbatim', () => {
    const rows = parseHedgeTable(skill.body);
    expect(rows).toEqual(HEDGE_TABLE.map(({ p, cell }) => ({ p, phrases: cell })));
  });

  test('fast path only uses receipts commands and flags from the cli contract', () => {
    const commands = commandsFor(skill.body, 'receipts');
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const name = command.split(/\s+/)[1] ?? '';
      expect(Object.keys(RECEIPTS_CLI)).toContain(name);
      for (const flag of flagsOf(command)) {
        expect([...(RECEIPTS_CLI[name] ?? []), ...RECEIPTS_GLOBAL_FLAGS]).toContain(flag);
      }
    }
  });

  test('manual path only uses gbrain subcommands that exist', () => {
    const commands = gbrainCommands(skill);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const [, sub, next] = command.split(/\s+/);
      expect(GBRAIN_SUBCOMMANDS).toContain(sub ?? '');
      if (sub === 'takes' && next && !next.startsWith('people/')) {
        expect(TAKES_SUBCOMMANDS).toContain(next);
      }
    }
  });

  test('every takes add files the take on the speaker page with the speaker as holder', () => {
    for (const command of gbrainCommands(skill).filter((c) => c.startsWith('gbrain takes add'))) {
      const page = command.match(/takes add (\S+)/)?.[1];
      const holder = command.match(/--who (\S+)/)?.[1];
      expect(page).toBe('people/<slug>');
      expect(holder).toBe(page);
      expect(command).toContain('--kind bet');
      expect(command).toContain('--weight <p>');
    }
  });

  test('every takes resolve names a quality and evidence, and timeline-add never gets --source', () => {
    for (const command of gbrainCommands(skill)) {
      if (command.startsWith('gbrain takes resolve')) {
        expect(command).toContain('--quality');
        expect(command).toContain('--evidence');
      }
      if (command.startsWith('gbrain timeline-add')) expect(flagsOf(command)).not.toContain('--source');
    }
  });

  test('never uses accusatory language outside the rules that forbid it', () => {
    const outsideRules = skill.body
      .replace(section(skill.body, 'Non-negotiables'), '')
      .replace(section(skill.body, 'Anti-patterns'), '');
    expect(outsideRules).not.toMatch(/\b(lied|liar|lying|fraud)\b/i);
  });
});

describe('the pack as a whole', () => {
  test('no two skills share a trigger (MECE)', () => {
    const all = skills.flatMap((s) => s.frontmatter.triggers.map(normalizeText));
    expect(new Set(all).size).toBe(all.length);
  });

  test('only receipts-ask is read-only, and it issues no gbrain writes', () => {
    const readOnly = skills.filter((s) => !s.frontmatter.mutating).map((s) => s.slug);
    expect(readOnly).toEqual(['receipts-ask']);
    const ask = skills.find((s) => s.slug === 'receipts-ask');
    expect(ask?.body).not.toMatch(GBRAIN_WRITES);
  });

  test('the bootstrap runbook also sticks to the receipts cli contract', () => {
    for (const command of commandsFor(readPackFile('runbooks/bootstrap.md'), 'receipts')) {
      const name = command.split(/\s+/)[1] ?? '';
      expect(Object.keys(RECEIPTS_CLI)).toContain(name);
      for (const flag of flagsOf(command)) {
        expect([...(RECEIPTS_CLI[name] ?? []), ...RECEIPTS_GLOBAL_FLAGS]).toContain(flag);
      }
    }
  });
});

// Activates once src/hedge.ts lands: the table agents follow on the manual
// path must give the same numbers as the engine's fast path.
describe.skipIf(!packFileExists('src/hedge.ts'))('hedge table agrees with src/hedge.ts', () => {
  test.each(HEDGE_TABLE.flatMap(({ p, probes }) => probes.map((probe) => [probe, p] as const)))(
    'impliedProbability(%p) = %p',
    async (probe, p) => {
      const hedge = (await import(join(PACK_ROOT, 'src/hedge.ts'))) as { impliedProbability: (h: string) => number };
      expect(hedge.impliedProbability(probe)).toBeCloseTo(p, 5);
    },
  );
});
