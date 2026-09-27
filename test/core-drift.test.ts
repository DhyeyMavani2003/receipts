import { describe, expect, test } from 'bun:test';
import {
  applyDrift,
  chains,
  daysBetween,
  detectDrift,
  DRIFT_SYSTEM,
  driftUserPrompt,
  keepCuratedLabels,
  mergeTransition,
  refineDrift,
  zDriftLabels,
} from '../src/drift.ts';
import type { JsonRequest, JsonResponse, LLM } from '../src/llm/provider.ts';
import { LLMUnavailableError } from '../src/llm/provider.ts';
import type { Claim, DriftInfo } from '../src/types.ts';
import { ledgerOf, makeClaim } from './core-fixtures.ts';

// Minimal LLM double: records requests, answers from a function.
class FakeLLM implements LLM {
  readonly name = 'fake';
  readonly requests: JsonRequest<unknown>[] = [];
  constructor(private readonly answer: (req: JsonRequest<unknown>) => unknown) {}
  async json<T>(req: JsonRequest<T>): Promise<JsonResponse<T>> {
    this.requests.push(req as JsonRequest<unknown>);
    return { data: this.answer(req as JsonRequest<unknown>) as T, citations: [], model: 'fake' };
  }
}

// Each statement comes from its own source, as in real chains.
const episode = (saidDate: string) => ({ title: `Episode ${saidDate}`, url: `https://example.com/ep-${saidDate}`, date: saidDate, kind: 'podcast' as const });
const robotaxi = (saidDate: string, targetDate: string | undefined, claim: string, over: Partial<Claim> = {}): Claim =>
  makeClaim({ saidDate, targetDate, claim, topic: 'tesla-robotaxi', source: episode(saidDate), ...over });

// Real-shaped chain: deadline slips, a same-deadline restatement, then a changed goal.
const c2019 = robotaxi('2019-04-22', '2020-12-31', 'Tesla will have robotaxis in 2020.');
const c2020 = robotaxi('2020-07-09', '2021-12-31', 'Tesla will have robotaxis in 2021.');
const c2020b = robotaxi('2020-09-22', '2021-12-01', 'Tesla will have robotaxis by the end of 2021.');
const c2022 = robotaxi('2022-01-26', '2021-06-30', 'Robotaxis were supposed to be here in mid 2021.');
const cNoDate = robotaxi('2023-01-01', undefined, 'Robotaxis are coming.');
const c2024 = robotaxi('2024-04-23', '2024-08-08', 'Tesla will unveil a robotaxi on 8/8.');
const mars = makeClaim({ saidDate: '2016-06-01', targetDate: '2018-12-31', claim: 'Mars mission in 2018.', topic: 'mars-landing' });
const other = makeClaim({ personSlug: 'sam-altman', person: 'Sam Altman', topic: 'tesla-robotaxi', claim: 'Other speaker.' });

const ledger = ledgerOf([c2024, cNoDate, c2020b, mars, c2022, c2019, other, c2020]);

describe('chains', () => {
  test('one chain per person and topic, oldest claim first, never mixing speakers', () => {
    const cs = chains(ledger);
    expect(cs.map((c) => [c.personSlug, c.topic, c.claims.length])).toEqual([
      ['elon-musk', 'mars-landing', 1],
      ['elon-musk', 'tesla-robotaxi', 6],
      ['sam-altman', 'tesla-robotaxi', 1],
    ]);
    expect(cs[1]!.claims.map((c) => c.saidDate)).toEqual([
      '2019-04-22', '2020-07-09', '2020-09-22', '2022-01-26', '2023-01-01', '2024-04-23',
    ]);
  });
});

describe('detectDrift', () => {
  const d = detectDrift(ledger);

  test('labels every claim', () => {
    expect(d.size).toBe(ledger.claims.length);
    expect(d.get(mars.id)?.label).toBe('first');
    expect(d.get(other.id)?.label).toBe('first');
  });

  test('deadline moves of 60+ days are slips; smaller moves are reaffirmations', () => {
    expect(d.get(c2019.id)).toEqual({ label: 'first', note: 'First recorded claim on this topic, with a deadline of 2020-12-31.' });
    expect(d.get(c2020.id)).toEqual({ label: 'pushed_later', previousClaimId: c2019.id, note: 'Deadline moved from 2020-12-31 to 2021-12-31.' });
    expect(d.get(c2020b.id)).toEqual({
      label: 'reaffirmed',
      previousClaimId: c2020.id,
      note: 'Restated with a deadline of 2021-12-01 (previously 2021-12-31).',
    });
    expect(d.get(c2022.id)?.label).toBe('pulled_earlier');
    expect(d.get(c2022.id)?.note).toBe('Deadline moved earlier, from 2021-12-01 to 2021-06-30.');
  });

  test('an undated claim is reaffirmed; the next dated claim compares with the last dated one', () => {
    expect(d.get(cNoDate.id)).toEqual({ label: 'reaffirmed', previousClaimId: c2022.id, note: 'Restated the claim; no earlier deadline to compare.' });
    expect(d.get(c2024.id)).toEqual({ label: 'pushed_later', previousClaimId: c2022.id, note: 'Deadline moved from 2021-06-30 to 2024-08-08.' });
  });

  test('the 60-day threshold is inclusive on both sides', () => {
    const base = robotaxi('2020-01-01', '2021-01-01', 'base');
    const at = (target: string) => detectDrift(ledgerOf([base, robotaxi('2020-02-01', target, `t ${target}`)]));
    const labelFor = (target: string) => [...at(target).values()][1]!.label;
    expect(daysBetween('2021-01-01', '2021-03-02')).toBe(60);
    expect(labelFor('2021-03-02')).toBe('pushed_later');
    expect(labelFor('2021-03-01')).toBe('reaffirmed');
    expect(labelFor('2020-11-02')).toBe('pulled_earlier');
    expect(labelFor('2020-11-03')).toBe('reaffirmed');
  });
});

describe('detectDrift: siblings and met milestones', () => {
  test('claims from one episode never measure each other (both are first)', () => {
    const a = robotaxi('2024-03-15', '2025-12-31', 'Acme will ship 1,000 robots by the end of 2025.');
    const b = robotaxi('2024-03-15', '2026-12-31', 'Acme will ship 10,000 robots by the end of 2026.');
    const d = detectDrift(ledgerOf([a, b]));
    expect(d.get(a.id)?.label).toBe('first');
    expect(d.get(b.id)?.label).toBe('first');
  });

  test('the date decides the occasion, not the URL', () => {
    const a = robotaxi('2024-03-15', '2025-12-31', 'First milestone.');
    const b = robotaxi('2025-01-15', '2026-12-31', 'Second milestone.', { source: episode('2024-03-15') });
    expect(detectDrift(ledgerOf([a, b])).get(b.id)?.label).toBe('pushed_later');
  });

  test('a later episode compares with the closest deadline of the last earlier episode', () => {
    const a = robotaxi('2024-03-15', '2025-12-31', 'Milestone A.');
    const b = robotaxi('2024-03-15', '2026-12-31', 'Milestone B.');
    const c = robotaxi('2025-01-15', '2026-12-31', 'Milestone B again.');
    expect(detectDrift(ledgerOf([a, b, c])).get(c.id)).toEqual({
      label: 'reaffirmed',
      previousClaimId: b.id,
      note: 'Restated with the same deadline, 2026-12-31.',
    });
  });

  test('no slip is measured against a deadline that was met', () => {
    const met = robotaxi('2025-06-11', '2025-06-28', 'A car drives itself to a customer on June 28.', { verdict: 'correct' });
    const next = robotaxi('2025-07-23', '2025-12-31', 'Ride-hailing for half the US by the end of 2025.');
    expect(detectDrift(ledgerOf([met, next])).get(next.id)).toEqual({
      label: 'reaffirmed',
      previousClaimId: met.id,
      note: 'The earlier deadline (2025-06-28) was met; this sets a new one, 2025-12-31.',
    });
  });

  test('refineDrift skips chains from a single episode and never relabels a first claim', async () => {
    const a = robotaxi('2024-03-15', '2025-12-31', 'Milestone A.');
    const b = robotaxi('2024-03-15', '2026-12-31', 'Milestone B.');
    const llm = new FakeLLM(() => ({ transitions: [{ claimId: b.id, label: 'escalated', note: 'Bigger.' }] }));
    const m = await refineDrift(ledgerOf([a, b]), llm);
    expect(llm.requests).toHaveLength(0);
    expect(m.get(b.id)?.label).toBe('first');
    expect(mergeTransition({ label: 'first', note: 'First.' }, 'escalated', 'Bigger.')).toEqual({ label: 'first', note: 'First.' });
  });
});

describe('mergeTransition', () => {
  const slip: DriftInfo = { label: 'pushed_later', previousClaimId: 'p', note: 'Deadline moved from 2020-12-31 to 2021-12-31.' };
  const same: DriftInfo = { label: 'reaffirmed', previousClaimId: 'p', note: 'Restated.' };

  test('the model cannot invent or erase a date slip', () => {
    expect(mergeTransition(same, 'pushed_later', 'moved')).toBe(same);
    expect(mergeTransition(slip, 'reaffirmed', 'same')).toBe(slip);
    expect(mergeTransition(slip, 'pulled_earlier', 'earlier')).toBe(slip);
  });

  test('escalated/softened upgrade a reaffirmation but not a measured slip', () => {
    expect(mergeTransition(same, 'softened', 'Now framed as a hope.')).toEqual({ label: 'softened', previousClaimId: 'p', note: 'Now framed as a hope.' });
    expect(mergeTransition(slip, 'escalated', 'Bigger.')).toBe(slip);
  });

  test('goalposts_moved/reversed win over a slip and keep the slip sentence', () => {
    expect(mergeTransition(slip, 'goalposts_moved', 'Target changed to a demo.')).toEqual({
      label: 'goalposts_moved',
      previousClaimId: 'p',
      note: 'Target changed to a demo. Deadline moved from 2020-12-31 to 2021-12-31.',
    });
    const dated = 'Deadline moved from 2020-12-31 to 2021-12-31 and the goal changed.';
    expect(mergeTransition(slip, 'reversed', dated).note).toBe(dated);
    expect(mergeTransition(same, 'reversed', '  ').note).toBe('Labeled reversed relative to the previous claim.');
  });

  test('a note that implies motive is replaced with a plain one', () => {
    expect(mergeTransition(same, 'softened', 'He misled investors by hedging.').note).toBe('Labeled softened relative to the previous claim.');
    expect(mergeTransition(slip, 'goalposts_moved', 'Another broken promise.').note).toBe(
      'Labeled goalposts moved relative to the previous claim. Deadline moved from 2020-12-31 to 2021-12-31.',
    );
  });
});

describe('refineDrift', () => {
  test('asks once per chain with 2+ claims, schema drift_labels, deterministic prompt', async () => {
    const llm = new FakeLLM(() => ({ transitions: [] }));
    const m = await refineDrift(ledger, llm);
    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0]!;
    expect(req.schemaName).toBe('drift_labels');
    expect(req.schema).toBe(zDriftLabels);
    expect(req.system).toBe(DRIFT_SYSTEM);
    expect(req.user).toBe(driftUserPrompt(chains(ledger)[1]!, detectDrift(ledger)));
    expect(req.user).toContain(`claimId: ${c2024.id}`);
    expect(req.user).toContain('code label: pushed_later');
    expect(m).toEqual(detectDrift(ledger));
  });

  test('applies model upgrades under the precedence rules', async () => {
    const llm = new FakeLLM(() => ({
      transitions: [
        { claimId: c2020.id, label: 'reaffirmed', note: 'Same.' },
        { claimId: c2020b.id, label: 'escalated', note: 'Now promises a million robotaxis.' },
        { claimId: c2024.id, label: 'goalposts_moved', note: 'Target changed from robotaxis on the road to a product unveiling.' },
      ],
    }));
    const m = await refineDrift(ledger, llm);
    expect(m.get(c2020.id)?.label).toBe('pushed_later');
    expect(m.get(c2020b.id)).toEqual({ label: 'escalated', previousClaimId: c2020.id, note: 'Now promises a million robotaxis.', labeledBy: 'fake' });
    expect(m.get(c2024.id)?.label).toBe('goalposts_moved');
    expect(m.get(c2024.id)?.note).toContain('Deadline moved from 2021-06-30 to 2024-08-08.');
    expect(m.get(c2019.id)?.label).toBe('first');
  });

  test('junk ids, the first claim, bad labels and junk payloads fall back to deterministic labels', async () => {
    const det = detectDrift(ledger);
    const junk = [
      { transitions: [{ claimId: 'deadbeef0000', label: 'reversed', note: 'x' }] },
      { transitions: [{ claimId: c2019.id, label: 'reversed', note: 'x' }] },
      { transitions: [{ claimId: c2020b.id, label: 'lied', note: 'x' }, null, 42] },
      { transitions: [{ claimId: other.id, label: 'reversed', note: 'x' }] },
      { transitions: 'nope' },
      null,
      'not json',
    ];
    for (const data of junk) {
      expect(await refineDrift(ledger, new FakeLLM(() => data))).toEqual(det);
    }
  });

  test('a failing model call keeps deterministic labels and warns', async () => {
    const warnings: string[] = [];
    const llm: LLM = {
      name: 'down',
      json: async () => {
        throw new LLMUnavailableError('fixture missing: drift_labels-abc.json');
      },
    };
    const m = await refineDrift(ledger, llm, { onWarning: (w) => warnings.push(w) });
    expect(m).toEqual(detectDrift(ledger));
    expect(warnings).toEqual([
      'drift: kept deterministic labels for elon-musk/tesla-robotaxi: fixture missing: drift_labels-abc.json',
    ]);
  });

  test('personSlug limits both the model calls and the result', async () => {
    const llm = new FakeLLM(() => ({ transitions: [] }));
    const m = await refineDrift(ledger, llm, { personSlug: 'sam-altman' });
    expect(llm.requests).toHaveLength(0);
    expect([...m.keys()]).toEqual([other.id]);
  });
});

describe('refineDrift keeps curated seed labels', () => {
  const seed = (c: Claim, drift?: DriftInfo): Claim => ({ ...c, origin: 'seed', ...(drift ? { drift } : {}) });
  const handLabel: DriftInfo = { label: 'escalated', previousClaimId: c2020.id, note: 'Hand-written.', labeledBy: 'human:seed-drift' };
  const liveSays = (id: string) => new FakeLLM(() => ({ transitions: [{ claimId: id, label: 'goalposts_moved', note: 'Model relabel.' }] }));

  test('a seed-only chain is answered from the curated labels, never the live model', async () => {
    const l = ledgerOf([seed(c2019), seed(c2020), seed(c2020b)]);
    const live = liveSays(c2020b.id);
    const curated = new FakeLLM(() => ({ transitions: [{ claimId: c2020b.id, label: 'escalated', note: 'Curated.' }] }));
    const m = await refineDrift(l, live, { curated });
    expect(live.requests).toHaveLength(0);
    expect(curated.requests).toHaveLength(1);
    expect(m.get(c2020b.id)?.label).toBe('escalated');
  });

  test('with no curated recording for the chain, the live model labels it', async () => {
    const l = ledgerOf([seed(c2019), seed(c2020), seed(c2020b)]);
    const live = liveSays(c2020b.id);
    const curated: LLM = { name: 'replay', json: async () => { throw new LLMUnavailableError('No replay fixture'); } };
    const m = await refineDrift(l, live, { curated });
    expect(live.requests).toHaveLength(1);
    expect(m.get(c2020b.id)?.label).toBe('goalposts_moved');
  });

  test('a hand-labeled seed claim keeps its label when a new episode joins the chain, unless relabel', async () => {
    const fresh = robotaxi('2025-01-01', '2026-12-31', 'Robotaxis in 2026.');
    const l = ledgerOf([seed(c2019), seed(c2020), seed(c2020b, handLabel), fresh]);
    const kept = await refineDrift(l, liveSays(c2020b.id));
    expect(kept.get(c2020b.id)).toEqual(handLabel);
    const relabeled = await refineDrift(l, liveSays(c2020b.id), { relabel: true });
    expect(relabeled.get(c2020b.id)?.label).toBe('goalposts_moved');
  });
});

describe('keepCuratedLabels', () => {
  test('the code-only path keeps hand-written labels on seed claims and nothing else', () => {
    const hand: DriftInfo = { label: 'escalated', previousClaimId: c2020.id, note: 'Hand-written.', labeledBy: 'human:seed-drift' };
    const model: DriftInfo = { label: 'escalated', previousClaimId: c2020.id, note: 'Model.', labeledBy: 'gpt-5' };
    const l = ledgerOf([c2019, c2020, { ...c2020b, origin: 'seed', drift: hand }, { ...c2022, drift: model }]);
    const m = keepCuratedLabels(l, detectDrift(l));
    expect(m.get(c2020b.id)).toEqual(hand);
    expect(m.get(c2022.id)).toEqual(detectDrift(l).get(c2022.id));
  });
});

describe('applyDrift', () => {
  test('returns a new ledger with drift set only for mapped claims', () => {
    const m = new Map<string, DriftInfo>([[mars.id, { label: 'first', note: 'First.' }]]);
    const before = ledgerOf([mars, other]);
    const after = applyDrift(before, m);
    expect(after).not.toBe(before);
    expect(after.claims[0]!.drift).toEqual({ label: 'first', note: 'First.' });
    expect(after.claims[1]).toBe(other);
    expect(before.claims[0]!.drift).toBeUndefined();
  });
});
