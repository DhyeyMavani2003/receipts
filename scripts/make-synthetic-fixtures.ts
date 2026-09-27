// Regenerates the offline replay fixtures for extracting claims from
// fixtures/transcripts/synthetic-interview.txt (a SYNTHETIC interview; Dana
// Founder and Ferrowind Robotics are fictional).
//
// The model output below is hand-written to the extraction spec. Running it
// through extractClaims() with a recording provider writes fixtures whose
// keys match the current EXTRACT_SYSTEM and extractUserPrompt(), so after a
// prompt change: `bun scripts/make-synthetic-fixtures.ts`. Afterwards, older
// fixtures from this script (response.model === SYNTHETIC_MODEL) are removed.

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { extractClaims } from '../src/extract.ts';
import type { ExtractedClaim } from '../src/extract.ts';
import { MockLLM } from '../src/llm/mock.ts';
import type { JsonRequest } from '../src/llm/provider.ts';
import { RecordingLLM, fixtureFileName } from '../src/llm/replay.ts';
import { checkQuote } from '../src/quote-check.ts';
import { loadTranscript } from '../src/transcript/load.ts';
import type { SourceRef, Transcript } from '../src/types.ts';

const ROOT = join(import.meta.dir, '..');
export const SYNTHETIC_TRANSCRIPT = join(ROOT, 'fixtures', 'transcripts', 'synthetic-interview.txt');
export const FIXTURES_DIR = join(ROOT, 'fixtures', 'llm');
export const SYNTHETIC_MODEL = 'synthetic-fixture';
export const SYNTHETIC_SPEAKER = 'Dana Founder';
export const SYNTHETIC_HOST = 'Sam Host';

const BASE_SOURCE: Omit<SourceRef, 'date'> = {
  title: 'Synthetic Interview (test fixture)',
  url: 'https://example.com/synthetic-interview',
  kind: 'podcast',
};

/**
 * The source every demo/test uses first, plus the recording date the
 * transcript header asks for; every deadline in this interview is stated
 * explicitly, so the same claims fit both.
 */
export const SYNTHETIC_SOURCES: SourceRef[] = [
  { ...BASE_SOURCE, date: '2024-03-15' },
  { ...BASE_SOURCE, date: '2025-01-15' },
];

type Draft = Omit<ExtractedClaim, 'targetDate' | 'targetDateInferred'> & { targetDate?: string; targetDateInferred?: boolean };

function claim(d: Draft): ExtractedClaim {
  return { ...d, targetDate: d.targetDate ?? null, targetDateInferred: d.targetDateInferred ?? false };
}

/** What a careful extractor returns for Dana Founder's turns, in transcript order. Quotes are exact spans. */
export const SYNTHETIC_CLAIMS: ExtractedClaim[] = [
  claim({
    quote: 'We shipped 1,200 F2 robots to paying customers in 2024.',
    claim: 'Ferrowind Robotics shipped 1,200 F2 humanoid robots to paying customers in 2024.',
    type: 'factual',
    topic: 'ferrowind-shipment-history',
    resolutionCriteria: 'Ferrowind shipment disclosures or credible industry reporting show about 1,200 F2 robots delivered to paying customers in 2024.',
    hedge: '',
    specificity: 5,
  }),
  claim({
    quote: "We shipped 1,200 F2 robots to paying customers in 2024. That's up from about three hundred in 2023.",
    claim: 'Ferrowind Robotics shipped about 300 robots to paying customers in 2023.',
    type: 'factual',
    topic: 'ferrowind-shipment-history',
    resolutionCriteria: 'Ferrowind shipment disclosures or credible industry reporting show roughly 300 robots delivered to paying customers in 2023.',
    hedge: '',
    specificity: 4,
  }),
  claim({
    quote: 'We just finished our first real production line in Reno.',
    claim: 'Ferrowind Robotics has finished building its first full production line, in Reno.',
    type: 'factual',
    topic: 'ferrowind-manufacturing',
    resolutionCriteria: 'Company announcements, permits or local news confirm a completed Ferrowind production line in Reno at the time of the interview.',
    hedge: '',
    specificity: 3,
  }),
  claim({
    quote: "So I'll say it plainly: we will ship ten thousand F2 robots by the end of 2025, for sure.",
    claim: 'Ferrowind Robotics will ship 10,000 F2 humanoid robots by the end of 2025.',
    type: 'prediction',
    topic: 'ferrowind-f2-shipments',
    targetDate: '2025-12-31',
    resolutionCriteria: 'Ferrowind shipment figures or credible reporting show at least 10,000 F2 robots shipped to customers by 2025-12-31.',
    hedge: 'for sure',
    specificity: 5,
  }),
  claim({
    quote: 'A million home robots by 2027 is not going to happen, not from us and not from anybody else.',
    claim: 'Neither Ferrowind Robotics nor any other company will have one million humanoid robots in homes by the end of 2027.',
    type: 'prediction',
    topic: 'home-humanoid-adoption',
    targetDate: '2027-12-31',
    resolutionCriteria: 'Industry data or credible reporting shows that no company has one million humanoid robots installed in homes as of 2027-12-31.',
    hedge: '',
    specificity: 4,
  }),
  claim({
    quote: "The F3 will launch at our developer day in March 2026, and the F3 is the first robot we've designed with the home in mind.",
    claim: 'Ferrowind Robotics will launch its F3 robot at its developer day in March 2026.',
    type: 'prediction',
    topic: 'ferrowind-f3-launch',
    targetDate: '2026-03-31',
    resolutionCriteria: 'Ferrowind publicly launches the F3 at a developer day held in March 2026, as shown by the event record or news coverage.',
    hedge: '',
    specificity: 5,
  }),
  claim({
    quote: "I think we'll be cash-flow positive by the second quarter of 2026. Not profitable on a GAAP basis, cash-flow positive.",
    claim: 'Ferrowind Robotics will be cash-flow positive, though not necessarily GAAP-profitable, by the end of the second quarter of 2026.',
    type: 'prediction',
    topic: 'ferrowind-cash-flow',
    targetDate: '2026-06-30',
    resolutionCriteria: 'Ferrowind financial statements or credible reporting show positive cash flow for a period ending on or before 2026-06-30.',
    hedge: 'I think',
    specificity: 5,
  }),
  claim({
    quote: 'Every F2 comes with what we call the skills plan. It\'s a monthly fee per robot.',
    claim: "Ferrowind Robotics sells every F2 robot with a 'skills plan', a monthly per-robot subscription.",
    type: 'factual',
    topic: 'ferrowind-business-model',
    resolutionCriteria: 'Ferrowind pricing pages, contracts or customer reports show a mandatory monthly per-robot skills plan for the F2.',
    hedge: '',
    specificity: 3,
  }),
  claim({
    quote: 'Our second factory, in Monterrey, will probably open by the middle of 2026.',
    claim: 'Ferrowind Robotics will open its second factory, in Monterrey, Mexico, by the middle of 2026.',
    type: 'prediction',
    topic: 'ferrowind-monterrey-factory',
    targetDate: '2026-06-30',
    resolutionCriteria: 'Company announcements or local news show Ferrowind\'s Monterrey factory open and operating by 2026-06-30.',
    hedge: 'probably',
    specificity: 5,
  }),
  claim({
    quote: 'Half of our revenue will come from outside the United States by the end of 2027, definitely.',
    claim: "Half of Ferrowind Robotics' revenue will come from outside the United States by the end of 2027.",
    type: 'prediction',
    topic: 'ferrowind-international-revenue',
    targetDate: '2027-12-31',
    resolutionCriteria: 'Ferrowind financial disclosures or credible reporting show at least 50% of its revenue coming from outside the United States by 2027-12-31.',
    hedge: 'definitely',
    specificity: 4,
  }),
  claim({
    quote: "I'm confident humanoid robots will be working in at least one major hospital in the US by the end of 2026.",
    claim: 'Humanoid robots from any company will be working in at least one major US hospital by the end of 2026.',
    type: 'prediction',
    topic: 'humanoid-robots-hospitals',
    targetDate: '2026-12-31',
    resolutionCriteria: 'Credible reporting or hospital announcements show humanoid robots in regular operational use at a major US hospital by 2026-12-31.',
    hedge: "I'm confident",
    specificity: 4,
  }),
  claim({
    quote: "Maybe by 2030 you'll be able to buy a home robot for less than ten thousand dollars.",
    claim: 'A home robot will be available to buy for less than $10,000 by 2030.',
    type: 'prediction',
    topic: 'home-robot-price',
    targetDate: '2030-12-31',
    resolutionCriteria: 'A general-purpose home robot is on sale to consumers at a list price under $10,000 by 2030-12-31.',
    hedge: 'maybe',
    specificity: 4,
  }),
  claim({
    quote: 'We might go public in 2027.',
    claim: 'Ferrowind Robotics will go public in 2027.',
    type: 'prediction',
    topic: 'ferrowind-ipo',
    targetDate: '2027-12-31',
    resolutionCriteria: 'Ferrowind shares begin trading on a public stock exchange during 2027.',
    hedge: 'might',
    specificity: 4,
  }),
  claim({
    quote: 'I think open-sourcing the base models for robots is the right call for safety.',
    claim: 'Open-sourcing the base AI models that control robots is the right choice for safety.',
    type: 'stance',
    topic: 'open-source-robot-models',
    resolutionCriteria: 'Dana Founder continues to argue for open robot base models, and Ferrowind continues to publish its base-model weights.',
    hedge: 'I think',
    specificity: 3,
  }),
  claim({
    quote: "I'm against a robot tax. Taxing robots is taxing productivity.",
    claim: 'Governments should not tax robots that replace workers.',
    type: 'stance',
    topic: 'robot-tax',
    resolutionCriteria: 'Dana Founder continues to publicly oppose taxes on robots or automation.',
    hedge: '',
    specificity: 3,
  }),
  claim({
    quote: 'If you want to help workers, and we should, fund training and wage insurance directly.',
    claim: 'Governments should help workers affected by automation by funding training and wage insurance directly.',
    type: 'stance',
    topic: 'automation-worker-support',
    resolutionCriteria: 'Dana Founder continues to advocate direct funding of worker training and wage insurance as the response to automation.',
    hedge: '',
    specificity: 3,
  }),
];

/** The mock model: every curated claim whose quote lies in the excerpt it was sent. */
export function syntheticAnswer(req: JsonRequest<unknown>): { claims: ExtractedClaim[] } {
  return { claims: SYNTHETIC_CLAIMS.filter((c) => req.user.includes(c.quote)) };
}

function assertQuotesVerify(t: Transcript): void {
  const bad = SYNTHETIC_CLAIMS.filter((c) => !checkQuote(c.quote, t, { speaker: SYNTHETIC_SPEAKER }).verified || !t.text.includes(c.quote));
  if (bad.length > 0) throw new Error(`quotes that are not exact spans by ${SYNTHETIC_SPEAKER}:\n${bad.map((c) => `  ${c.quote}`).join('\n')}`);
}

function isOwnFixture(path: string): boolean {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))?.response?.model === SYNTHETIC_MODEL;
  } catch {
    return false;
  }
}

function removeStaleFixtures(dir: string, keep: ReadonlySet<string>): number {
  const stale = readdirSync(dir)
    .filter((f) => f.startsWith('extract_claims-') && f.endsWith('.json') && !keep.has(f))
    .map((f) => join(dir, f))
    .filter(isOwnFixture);
  for (const path of stale) rmSync(path);
  return stale.length;
}

export async function makeSyntheticFixtures(dir: string = FIXTURES_DIR): Promise<{ removed: number; written: number; claims: number }> {
  const t = await loadTranscript(SYNTHETIC_TRANSCRIPT);
  assertQuotesVerify(t);
  const model = new MockLLM(syntheticAnswer, { model: SYNTHETIC_MODEL });
  const recorder = new RecordingLLM(model, dir);
  let claims = 0;
  for (const source of SYNTHETIC_SOURCES) {
    const res = await extractClaims(t, recorder, { speaker: SYNTHETIC_SPEAKER, host: SYNTHETIC_HOST, source });
    if (res.dropped.length > 0) throw new Error(`extraction dropped quotes: ${JSON.stringify(res.dropped)}`);
    claims = res.claims.length;
  }
  const written = new Set(model.calls.map(fixtureFileName));
  return { removed: removeStaleFixtures(dir, written), written: written.size, claims };
}

if (import.meta.main) {
  const { removed, written, claims } = await makeSyntheticFixtures();
  console.log(`synthetic fixtures: ${written} written, ${removed} stale removed, ${claims} claims per source (${SYNTHETIC_SOURCES.map((s) => s.date).join(', ')})`);
}
