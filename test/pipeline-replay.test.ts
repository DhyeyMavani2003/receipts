// The committed replay fixtures (scripts/make-synthetic-fixtures.ts) must
// answer a full offline extraction of the synthetic interview, and every
// claim they yield must survive quote-check.

import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractClaims } from '../src/extract.ts';
import { ReplayLLM } from '../src/llm/replay.ts';
import { checkQuote } from '../src/quote-check.ts';
import { loadTranscript } from '../src/transcript/load.ts';
import type { Transcript } from '../src/types.ts';
import {
  FIXTURES_DIR,
  SYNTHETIC_CLAIMS,
  SYNTHETIC_HOST,
  SYNTHETIC_MODEL,
  SYNTHETIC_SOURCES,
  SYNTHETIC_SPEAKER,
  SYNTHETIC_TRANSCRIPT,
} from '../scripts/make-synthetic-fixtures.ts';

let t: Transcript;
beforeAll(async () => {
  t = await loadTranscript(SYNTHETIC_TRANSCRIPT);
});

describe.each(SYNTHETIC_SOURCES.map((s) => [s.date, s] as const))('replayed extraction, said %s', (_date, source) => {
  let result: Awaited<ReturnType<typeof extractClaims>>;
  beforeAll(async () => {
    result = await extractClaims(t, new ReplayLLM(FIXTURES_DIR), { speaker: SYNTHETIC_SPEAKER, host: SYNTHETIC_HOST, source });
  });

  test('every fixture claim verifies and nothing is dropped', () => {
    expect(result.dropped).toEqual([]);
    expect(result.claims).toHaveLength(SYNTHETIC_CLAIMS.length);
    for (const c of result.claims) {
      expect(c.quoteVerified).toBe(true);
      expect(t.text).toContain(c.quote);
      expect(checkQuote(c.quote, t, { speaker: SYNTHETIC_SPEAKER }).verified).toBe(true);
    }
  });

  test('claims belong to the speaker, carry the source and a timestamp', () => {
    for (const c of result.claims) {
      expect(c).toMatchObject({ person: SYNTHETIC_SPEAKER, personSlug: 'dana-founder', saidDate: source.date, origin: 'extracted' });
      expect(c.source).toMatchObject(source);
      expect(c.source.timestampSec).toBeGreaterThan(0);
    }
  });

  test('predictions have deadlines on or after the day they were said; others have none', () => {
    const predictions = result.claims.filter((c) => c.type === 'prediction');
    expect(predictions.length).toBeGreaterThanOrEqual(8);
    for (const c of predictions) expect(c.targetDate! >= source.date).toBe(true);
    for (const c of result.claims.filter((x) => x.type !== 'prediction')) expect(c.targetDate).toBeUndefined();
  });

  test('hedges map to the intended probabilities', () => {
    const p = Object.fromEntries(result.claims.map((c) => [c.topic, c.impliedProbability]));
    expect(p).toMatchObject({
      'ferrowind-f2-shipments': 0.95,
      'ferrowind-cash-flow': 0.65,
      'ferrowind-monterrey-factory': 0.7,
      'humanoid-robots-hospitals': 0.9,
      'home-robot-price': 0.5,
      'ferrowind-ipo': 0.4,
    });
  });
});

test('fixture files are replay-only data: synthetic model, no keys', () => {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.startsWith('extract_claims-'));
  const ours = files.filter((f) => readFileSync(join(FIXTURES_DIR, f), 'utf8').includes(`"model": "${SYNTHETIC_MODEL}"`));
  expect(ours.length).toBeGreaterThanOrEqual(SYNTHETIC_SOURCES.length);
  for (const f of ours) expect(readFileSync(join(FIXTURES_DIR, f), 'utf8')).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
});
