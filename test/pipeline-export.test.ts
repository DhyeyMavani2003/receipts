import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GRADER_BRIEF, exportRiverSFT, graderInput, riverExample, riverLines } from '../src/export.ts';
import type { RiverExample } from '../src/export.ts';
import type { Claim, Grading } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

function withGrading(c: Claim, g: Partial<Grading>): Claim {
  const grading: Grading = {
    verdict: 'incorrect',
    confidence: 0.85,
    rationale: 'No robotaxi service operated by the deadline.',
    evidence: [{ url: 'https://news.example/robotaxi', title: 'Robotaxi check-in', date: '2021-01-05', snippet: 'No driverless rides yet.' }],
    gradedAt: '2026-01-01T00:00:00.000Z',
    gradedBy: 'gpt-test',
    ...g,
  };
  return { ...c, verdict: grading.verdict, grading };
}

const incorrect = withGrading(makeClaim({ saidDate: '2019-04-22', claim: 'Robotaxis in 2020.' }), {});
const lateCorrect = withGrading(makeClaim({ saidDate: '2018-01-01', claim: 'Starlink service by 2020.', targetDate: '2020-06-30' }), {
  verdict: 'correct',
  resolvedOn: '2020-10-27',
  evidence: [{ url: 'https://news.example/starlink' }],
});
const noEvidence = withGrading(makeClaim({ claim: 'No evidence.' }), { evidence: [] });
const tooEarly = withGrading(makeClaim({ claim: 'Too early.' }), { verdict: 'too_early' });
const pending = makeClaim({ claim: 'Pending.' });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'receipts-export-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('riverExample', () => {
  test('system brief, claim + evidence as input, verdict JSON as the answer', () => {
    const ex = riverExample(incorrect)!;
    expect(ex.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(ex.messages[0].content).toBe(GRADER_BRIEF);
    expect(ex.messages[1].content).toBe(graderInput(incorrect));
    expect(ex.messages[1].content).toContain('Claim (prediction): Robotaxis in 2020.');
    expect(ex.messages[1].content).toContain('Deadline: 2020-12-31');
    expect(ex.messages[1].content).toContain('[1] Robotaxi check-in (2021-01-05) https://news.example/robotaxi\n    No driverless rides yet.');
    expect(JSON.parse(ex.messages[2].content)).toEqual({
      verdict: 'incorrect',
      confidence: 0.85,
      rationale: 'No robotaxi service operated by the deadline.',
      resolvedOn: null,
    });
  });

  test('only final verdicts backed by evidence are exported', () => {
    expect(riverExample(noEvidence)).toBeNull();
    expect(riverExample(tooEarly)).toBeNull();
    expect(riverExample(pending)).toBeNull();
    expect(riverExample(withGrading(incorrect, { verdict: 'unresolvable', disputed: true, rationale: 'The judges disagreed.' }))).toBeNull();
    expect(JSON.parse(riverExample(lateCorrect)!.messages[2].content).resolvedOn).toBe('2020-10-27');
  });
});

describe('exportRiverSFT', () => {
  test('writes one JSON chat per line, oldest first, and returns the count', () => {
    const path = join(dir, 'nested', 'river-sft.jsonl');
    const n = exportRiverSFT(ledgerOf([pending, incorrect, tooEarly, noEvidence, lateCorrect]), path);
    expect(n).toBe(2);
    const text = readFileSync(path, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n').map((l) => JSON.parse(l) as RiverExample);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l.messages[2].content).verdict)).toEqual(['correct', 'incorrect']);
    expect(Object.keys(lines[0]!)).toEqual(['messages']);
  });

  test('an empty export writes an empty file', () => {
    const path = join(dir, 'empty.jsonl');
    expect(exportRiverSFT(ledgerOf([pending]), path)).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(riverLines(ledgerOf([]))).toEqual([]);
  });
});
