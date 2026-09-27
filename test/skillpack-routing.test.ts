import { describe, expect, test } from 'bun:test';

import {
  loadFixtures,
  loadSkills,
  matchingSkills,
  normalizeText,
  parseFixtures,
  readManifest,
  type RoutingFixture,
} from './skillpack-helpers.ts';

// Layer A of `gbrain routing-eval`, scoped to this pack: an intent routes to
// every skill whose trigger is a normalized substring of it.

const skills = loadSkills();
const packSlugs = new Set(skills.map((s) => s.slug));

type Outcome = 'pass' | 'missed' | 'ambiguous' | 'false_positive';

function routeOutcome(fixture: RoutingFixture): { outcome: Outcome; matched: string[] } {
  const matched = matchingSkills(fixture.intent, skills);
  const allowed = new Set([...(fixture.ambiguous_with ?? []), fixture.expected_skill ?? '']);
  const unexpected = matched.filter((slug) => !allowed.has(slug));
  const expectsPackSkill = fixture.expected_skill !== null && packSlugs.has(fixture.expected_skill);

  if (!expectsPackSkill) return { outcome: unexpected.length === 0 ? 'pass' : 'false_positive', matched };
  if (!matched.includes(fixture.expected_skill ?? '')) return { outcome: 'missed', matched };
  return { outcome: unexpected.length === 0 ? 'pass' : 'ambiguous', matched };
}

describe('routing fixture parser', () => {
  test('skips blank and comment lines', () => {
    const jsonl = '// header\n\n# note\n{"intent":"a b c","expected_skill":null}\n';
    expect(parseFixtures(jsonl)).toEqual([{ intent: 'a b c', expected_skill: null }]);
  });

  test('normalizes like gbrain: punctuation and case collapse to single spaces', () => {
    expect(normalizeText("What's their  Track-Record on?")).toBe('what s their track record on');
  });
});

describe('manifest routing_evals', () => {
  test('cover every skill in the pack', () => {
    const globs = readManifest().routing_evals ?? [];
    const files = globs.flatMap((g) => [...new Bun.Glob(g).scanSync({ cwd: `${import.meta.dir}/..` })]);
    expect(files.sort()).toEqual(skills.map((s) => `${s.path}/routing-eval.jsonl`).sort());
  });
});

describe.each(skills.map((s) => [s.slug, s] as const))('%s routing-eval.jsonl', (slug, skill) => {
  const fixtures = loadFixtures(skill.path);

  test('has >= 5 well-formed intents, >= 5 of them for this skill', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
    for (const f of fixtures) {
      expect(typeof f.intent).toBe('string');
      expect(f.intent.trim().length).toBeGreaterThan(0);
      expect(f.expected_skill === null || typeof f.expected_skill === 'string').toBe(true);
      if (f.ambiguous_with !== undefined) expect(Array.isArray(f.ambiguous_with)).toBe(true);
    }
    expect(fixtures.filter((f) => f.expected_skill === slug).length).toBeGreaterThanOrEqual(5);
  });

  test('includes a cross-skill case and a negative case', () => {
    expect(fixtures.some((f) => f.expected_skill !== null && f.expected_skill !== slug)).toBe(true);
    expect(fixtures.some((f) => f.expected_skill === null)).toBe(true);
  });

  test('no intent is a verbatim copy of a trigger (fixtures must paraphrase)', () => {
    const triggers = new Set(skills.flatMap((s) => s.frontmatter.triggers.map(normalizeText)));
    for (const f of fixtures) expect(triggers.has(normalizeText(f.intent))).toBe(false);
  });

  test.each(fixtures.map((f) => [f.intent, f] as const))('routes %p', (_intent, fixture) => {
    const { outcome, matched } = routeOutcome(fixture);
    expect({ outcome, matched }).toEqual({
      outcome: 'pass',
      matched: expect.any(Array) as unknown as string[],
    });
  });
});
