import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  PACK_ROOT,
  globCount,
  loadJudgeEvals,
  packFileExists,
  readManifest,
  readPackFile,
} from './skillpack-helpers.ts';

// Same shapes gbrain's manifest-v1.ts validator enforces.
const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/;
const STEP_KINDS = ['agent:', 'show user:', 'ask user:'];

const manifest = readManifest();
const pkg = JSON.parse(readPackFile('package.json')) as { name: string; version: string; license: string };

describe('skillpack.json', () => {
  test('declares every required v1 field with a valid shape', () => {
    expect(manifest.api_version).toBe('gbrain-skillpack-v1');
    expect(manifest.name).toMatch(NAME_RE);
    expect(manifest.version).toMatch(SEMVER_RE);
    expect(manifest.gbrain_min_version).toMatch(SEMVER_RE);
    expect(manifest.homepage).toMatch(/^https?:\/\//);
    for (const field of ['description', 'author', 'license'] as const) {
      expect(manifest[field].length).toBeGreaterThan(0);
    }
  });

  test('matches package.json name, version and license', () => {
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.license).toBe(pkg.license);
  });

  test('lists exactly the skill directories on disk, each with SKILL.md and routing-eval.jsonl', () => {
    const onDisk = readdirSync(join(PACK_ROOT, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `skills/${e.name}`)
      .sort();
    expect([...manifest.skills].sort()).toEqual(onDisk);
    for (const skill of manifest.skills) {
      expect(skill.startsWith('skills/')).toBe(true);
      expect(skill.includes('..')).toBe(false);
      expect(packFileExists(`${skill}/SKILL.md`)).toBe(true);
      expect(packFileExists(`${skill}/routing-eval.jsonl`)).toBe(true);
    }
  });

  test('uses the test, e2e, eval and routing globs the lead asked for, each matching files', () => {
    expect(manifest.unit_tests).toEqual(['test/**/*.test.ts']);
    expect(manifest.e2e_tests).toEqual(['e2e/**/*.test.ts']);
    expect(globCount(manifest.unit_tests ?? [])).toBeGreaterThan(0);
    expect(globCount(manifest.e2e_tests ?? [])).toBeGreaterThan(0);
    expect(globCount(manifest.llm_evals ?? [])).toBeGreaterThan(0);
    expect(globCount(manifest.routing_evals ?? [])).toBe(manifest.skills.length);
  });
});

describe('LICENSE', () => {
  test('is the MIT text with the 2026 Dhyey Mavani copyright', () => {
    const license = readPackFile('LICENSE');
    expect(manifest.license).toBe('MIT');
    expect(license.startsWith('MIT License')).toBe(true);
    expect(license).toContain('Copyright (c) 2026 Dhyey Mavani');
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });
});

describe('bootstrap runbook', () => {
  const path = manifest.runbooks?.bootstrap ?? '';
  const steps = readPackFile(path)
    .split('\n')
    .filter((line) => /^\d+\. /.test(line));

  test('is declared and has numbered steps', () => {
    expect(path).toBe('runbooks/bootstrap.md');
    expect(steps.length).toBeGreaterThanOrEqual(3);
  });

  test('every step is an agent:, show user: or ask user: step', () => {
    for (const step of steps) {
      const text = step.replace(/^\d+\. /, '');
      expect(STEP_KINDS.some((kind) => text.startsWith(kind))).toBe(true);
    }
  });

  test('never tells the agent to read or print the API key', () => {
    const runbook = readPackFile(path);
    expect(runbook).not.toMatch(/cat .*\.env|echo \$OPENAI_API_KEY|printenv OPENAI_API_KEY/);
    expect(runbook).toContain('I will not read or print it');
  });
});

describe('LLM-judge evals', () => {
  const evals = loadJudgeEvals();
  const skillSlugs = manifest.skills.map((s) => s.split('/').pop());

  test('evals/receipts.judge.json exists with the cross-modal shape', () => {
    expect(evals.map((e) => e.path)).toContain('evals/receipts.judge.json');
    for (const { data } of evals) {
      expect(data.task.length).toBeGreaterThan(0);
      expect(data.output).toBe('{{output-from-skill}}');
      expect(data.cases.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('every case has a unique name, criteria, input and a pack skill', () => {
    const cases = evals.flatMap((e) => e.data.cases);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    for (const c of cases) {
      expect(c.criteria.length).toBeGreaterThan(20);
      expect((c.input ?? '').length).toBeGreaterThan(0);
      expect(skillSlugs).toContain(c.skill);
    }
  });

  test('covers each skill with at least 3 cases', () => {
    const cases = evals.flatMap((e) => e.data.cases);
    for (const slug of skillSlugs) {
      expect(cases.filter((c) => c.skill === slug).length).toBeGreaterThanOrEqual(3);
    }
  });
});
