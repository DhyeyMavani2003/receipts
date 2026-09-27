// Writes replay fixtures for the drift_labels calls on the seed ledger, so
// `receipts demo --offline` and `receipts drift --offline` show judgment
// labels (goalposts moved, escalated) without an API key.
//
// The labels below are hand-written, like the seed verdicts, and the fixtures
// record them with model "human:seed-drift" so nobody mistakes them for model
// output. Date slips are still measured by code: a label here only matters
// where drift.ts lets judgment win (see mergeTransition). Rerun after editing
// the seed or the drift prompt:  bun scripts/make-seed-drift-fixtures.ts

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { chains, refineDrift, TRANSITION_LABELS } from '../src/drift.ts';
import { MockLLM } from '../src/llm/mock.ts';
import type { JsonRequest } from '../src/llm/provider.ts';
import { RecordingLLM, fixtureFileName } from '../src/llm/replay.ts';
import type { Claim, Ledger } from '../src/types.ts';

const ROOT = join(import.meta.dir, '..');
export const SEED_PATH = join(ROOT, 'data', 'seed', 'predictions.json');
export const FIXTURES_DIR = join(ROOT, 'fixtures', 'llm');
export const SEED_DRIFT_MODEL = 'human:seed-drift';

type Label = (typeof TRANSITION_LABELS)[number];

/** Hand labels per chain ("<personSlug>/<topic>"), keyed by the saidDate of each claim after the first. */
export const SEED_DRIFT_LABELS: Record<string, Record<string, { label: Label; note: string }>> = {
  'elon-musk/mars-landing': {
    '2017-09-29': { label: 'pushed_later', note: 'The first Mars flights moved from the 2018 window to a ship ready to launch in about five years, by 2022.' },
    '2024-09-07': { label: 'pushed_later', note: 'The first uncrewed Mars flights moved from 2022 to the late-2026 window.' },
    '2026-02-08': {
      label: 'goalposts_moved',
      note: 'The target changed from uncrewed Starships to Mars in 2026 to a self-growing city on the Moon within 10 years, with a Mars city put at more than 20 years.',
    },
  },
  'elon-musk/tesla-robotaxi': {
    '2019-04-22': { label: 'pushed_later', note: 'The self-driving milestone moved from a coast-to-coast drive in 2017 to a million robotaxis by the end of 2020.' },
    '2025-01-29': { label: 'pushed_later', note: 'The target moved from a million robotaxis by 2020 to a paid unsupervised service in Austin in June 2025.' },
    '2025-06-11': { label: 'reaffirmed', note: 'A June 2025 milestone again: a car driving itself from the factory to a customer on June 28.' },
    '2025-07-23': {
      label: 'escalated',
      note: 'Moved from one car driving itself to a customer (a milestone that was met) to ride-hailing for about half the US population by the end of 2025.',
    },
  },
  'elon-musk/tesla-semi': {
    '2025-08-11': { label: 'pushed_later', note: 'Semi production moved from starting in 2019 to volume production in 2026.' },
  },
  'jensen-huang/agi-timeline': {
    '2026-09-06': {
      label: 'escalated',
      note: 'Moved from predicting that AI would pass every human test within five years to saying that AGI has already arrived.',
    },
  },
};

export function loadSeedLedger(path: string = SEED_PATH): Ledger {
  const seed = JSON.parse(readFileSync(path, 'utf8')) as { claims: Claim[] };
  return { version: 1, updatedAt: new Date(0).toISOString(), claims: seed.claims };
}

/** The mock model: the hand labels for whichever chain the prompt describes. */
export function seedDriftAnswer(l: Ledger): (req: JsonRequest<unknown>) => unknown {
  const byId = new Map(l.claims.map((c) => [c.id, c]));
  return (req) => {
    const ids = [...req.user.matchAll(/^claimId: ([0-9a-f]{12})$/gm)].map((m) => m[1]!);
    const claims = ids.map((id) => byId.get(id)).filter((c): c is Claim => !!c);
    const first = claims[0];
    if (!first) throw new Error('drift prompt names no known claim');
    const labels = SEED_DRIFT_LABELS[`${first.personSlug}/${first.topic}`];
    if (!labels) throw new Error(`no hand labels for chain ${first.personSlug}/${first.topic}`);
    return {
      transitions: claims.slice(1).map((c) => {
        const l = labels[c.saidDate];
        if (!l) throw new Error(`no hand label for ${first.personSlug}/${first.topic} said ${c.saidDate}`);
        return { claimId: c.id, label: l.label, note: l.note };
      }),
    };
  };
}

function isOwnFixture(path: string): boolean {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))?.response?.model === SEED_DRIFT_MODEL;
  } catch {
    return false;
  }
}

export async function makeSeedDriftFixtures(dir: string = FIXTURES_DIR, seedPath: string = SEED_PATH): Promise<{ written: number; removed: number }> {
  const l = loadSeedLedger(seedPath);
  const expected = chains(l).filter((ch) => ch.claims.length >= 2).map((ch) => `${ch.personSlug}/${ch.topic}`);
  const unlabeled = expected.filter((k) => !SEED_DRIFT_LABELS[k]);
  if (unlabeled.length) throw new Error(`seed chains without hand labels: ${unlabeled.join(', ')}`);
  const model = new MockLLM(seedDriftAnswer(l), { model: SEED_DRIFT_MODEL });
  const errors: string[] = [];
  await refineDrift(l, new RecordingLLM(model, dir), { onWarning: (w) => errors.push(w) });
  if (errors.length) throw new Error(errors.join('\n'));
  const keep = new Set(model.calls.map(fixtureFileName));
  const stale = readdirSync(dir)
    .filter((f) => f.startsWith('drift_labels-') && !keep.has(f))
    .map((f) => join(dir, f))
    .filter(isOwnFixture);
  for (const path of stale) rmSync(path);
  return { written: keep.size, removed: stale.length };
}

if (import.meta.main) {
  const { written, removed } = await makeSeedDriftFixtures();
  console.log(`seed drift fixtures: ${written} written, ${removed} stale removed`);
}
