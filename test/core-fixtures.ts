// Claim builder shared by the core engine tests.

import { claimId } from '../src/ledger.ts';
import type { Claim, Ledger } from '../src/types.ts';

export function makeClaim(over: Partial<Claim> & { claim?: string } = {}): Claim {
  const personSlug = over.personSlug ?? 'elon-musk';
  const saidDate = over.saidDate ?? '2019-04-22';
  const text = over.claim ?? 'Tesla will have one million robotaxis on the road.';
  return {
    id: over.id ?? claimId(personSlug, saidDate, text),
    person: 'Elon Musk',
    personSlug,
    quote: text,
    quoteVerified: true,
    claim: text,
    type: 'prediction',
    topic: 'tesla-robotaxi',
    saidDate,
    targetDate: '2020-12-31',
    resolutionCriteria: 'Observable outcome.',
    hedge: '',
    impliedProbability: 0.85,
    specificity: 4,
    source: { title: 'Autonomy Day', url: 'https://example.com/ep', date: saidDate, kind: 'keynote' },
    verdict: 'pending',
    origin: 'extracted',
    ...over,
  };
}

export function ledgerOf(claims: Claim[]): Ledger {
  return { version: 1, updatedAt: '2026-01-01T00:00:00.000Z', claims };
}
