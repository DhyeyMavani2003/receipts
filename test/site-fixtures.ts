// SYNTHETIC sample ledger for the site tests and screenshots. The people,
// companies, quotes and evidence below are fictional; evidence URLs point at
// example.* domains on purpose.

import { applyDrift, detectDrift } from '../src/drift.ts';
import { claimId } from '../src/ledger.ts';
import type { Claim, FinalVerdict, Grading, Ledger, SourceRef } from '../src/types.ts';

type ClaimSeed = Partial<Claim> & Pick<Claim, 'person' | 'personSlug' | 'quote' | 'claim' | 'topic' | 'saidDate' | 'source'>;

function make(seed: ClaimSeed): Claim {
  return {
    id: claimId(seed.personSlug, seed.saidDate, seed.claim),
    quoteVerified: true,
    type: 'prediction',
    resolutionCriteria: 'Credible reporting confirms the outcome.',
    hedge: '',
    impliedProbability: 0.85,
    specificity: 4,
    verdict: 'pending',
    origin: 'extracted',
    ...seed,
  };
}

function graded(verdict: FinalVerdict, rationale: string, extra: Partial<Grading> = {}): Pick<Claim, 'verdict' | 'grading'> {
  return {
    verdict,
    grading: {
      verdict,
      confidence: 0.8,
      rationale,
      evidence: [],
      gradedAt: '2026-09-01T00:00:00.000Z',
      gradedBy: 'gpt-5',
      judges: [
        { judge: 'gpt-5#A', verdict, confidence: 0.8 },
        { judge: 'gpt-5#B', verdict, confidence: 0.8 },
      ],
      ...extra,
    },
  };
}

function src(title: string, date: string, kind: SourceRef['kind'], url: string, timestampSec?: number): SourceRef {
  const s: SourceRef = { title, date, kind, url };
  if (timestampSec !== undefined) {
    s.timestampSec = timestampSec;
    s.deepLink = `${url}&t=${timestampSec}s`;
  }
  return s;
}

const MARA = { person: 'Mara Quill', personSlug: 'mara-quill' };
const THEO = { person: 'Theo Brandt', personSlug: 'theo-brandt' };
const IRIS = { person: 'Iris Calloway', personSlug: 'iris-calloway' };
const JONAH = { person: 'Jonah Pike', personSlug: 'jonah-pike' };

function maraClaims(): Claim[] {
  const autonomyDay = src('Vantage Autonomy Day', '2019-04-22', 'keynote', 'https://www.youtube.com/watch?v=vantage0001', 3723);
  return [
    make({
      ...MARA,
      quote: 'Next year for sure, we will have over a million robotaxis on the road.',
      claim: 'Vantage Motors will have over one million robotaxis on the road by the end of 2020.',
      topic: 'vantage-robotaxi',
      saidDate: '2019-04-22',
      targetDate: '2020-12-31',
      targetDateInferred: true,
      hedge: 'for sure',
      impliedProbability: 0.95,
      specificity: 5,
      source: autonomyDay,
      gbrain: { page: 'people/mara-quill', row: 1, timelineWritten: true, resolvedQuality: 'incorrect' },
      ...graded('incorrect', 'By the end of 2020 Vantage operated no driverless robotaxis; its driver-assist software still required a supervising driver.', {
        evidence: [
          { url: 'https://autos.example.com/vantage-2020-autonomy-review', title: 'A year after Autonomy Day, no Vantage robotaxis', date: '2021-01-05', snippet: 'No Vantage vehicle operates without a safety driver.' },
          { url: 'https://filings.example.org/vantage-10k-2020', title: 'Vantage Motors annual report 2020', date: '2021-02-08' },
        ],
      }),
    }),
    make({
      ...MARA,
      quote: "I'm confident we'll have robotaxis operating in at least one city by the end of 2022.",
      claim: 'Vantage Motors will operate a driverless robotaxi service in at least one city by the end of 2022.',
      topic: 'vantage-robotaxi',
      saidDate: '2021-01-27',
      targetDate: '2022-12-31',
      hedge: "I'm confident",
      impliedProbability: 0.9,
      source: src('Vantage Q4 2020 earnings call', '2021-01-27', 'earnings_call', 'https://ir.example.com/vantage/q4-2020'),
      ...graded('incorrect', 'No Vantage driverless service operated in any city during 2022.', {
        evidence: [{ url: 'https://autos.example.com/vantage-2022-recap', title: 'Vantage ends 2022 without a robotaxi launch', date: '2023-01-10' }],
      }),
    }),
    make({
      ...MARA,
      quote: 'The robotaxi service launches in 2024. That is the plan and we are on track.',
      claim: 'Vantage Motors will launch a robotaxi service in 2024.',
      topic: 'vantage-robotaxi',
      saidDate: '2023-10-18',
      targetDate: '2024-12-31',
      hedge: 'on track',
      impliedProbability: 0.75,
      source: src('Vantage Q3 2023 earnings call', '2023-10-18', 'earnings_call', 'https://ir.example.com/vantage/q3-2023'),
      ...graded('partial', 'A small invite-only pilot began in December 2024 with safety monitors on board, short of a public service.', {
        evidence: [{ url: 'https://autos.example.com/vantage-pilot', title: 'Vantage starts invite-only robotaxi pilot', date: '2024-12-12' }],
        resolvedOn: '2024-12-12',
      }),
    }),
    make({
      ...MARA,
      quote: 'I think by the end of 2026 you will be able to hail a paid Vantage robotaxi in five cities.',
      claim: 'Paid Vantage robotaxi rides will be available in five cities by the end of 2026.',
      topic: 'vantage-robotaxi',
      saidDate: '2025-06-03',
      targetDate: '2026-12-31',
      hedge: 'I think',
      impliedProbability: 0.65,
      source: src('The Long Drive podcast, episode 212', '2025-06-03', 'podcast', 'https://www.youtube.com/watch?v=longdrive212', 1805),
    }),
    make({
      ...MARA,
      quote: 'We will land two cargo ships on Mars in 2022.',
      claim: 'Vantage Aerospace will land two uncrewed cargo ships on Mars in 2022.',
      topic: 'vantage-mars-landing',
      saidDate: '2017-09-29',
      targetDate: '2022-12-31',
      source: src('International Astronautical Congress keynote', '2017-09-29', 'keynote', 'https://www.youtube.com/watch?v=iac2017vant', 2410),
      ...graded('incorrect', 'No Vantage spacecraft had launched toward Mars by the end of 2022.'),
    }),
    make({
      ...MARA,
      quote: 'The Moon comes first. We will have a crewed base on the Moon by 2027.',
      claim: 'Vantage Aerospace will have a crewed base on the Moon by the end of 2027.',
      topic: 'vantage-mars-landing',
      saidDate: '2024-02-01',
      targetDate: '2027-12-31',
      source: src('Vantage Aerospace town hall', '2024-02-01', 'keynote', 'https://news.example.net/vantage-town-hall-2024'),
      verdict: 'too_early',
      grading: {
        verdict: 'too_early',
        confidence: 1,
        rationale: 'The deadline has not passed yet.',
        evidence: [],
        gradedAt: '2026-09-01T00:00:00.000Z',
        gradedBy: 'rule:deadline',
      },
    }),
    make({
      ...MARA,
      quote: 'Semi deliveries start next year, 2019 at the latest.',
      claim: 'Vantage Motors will start delivering its electric semi truck by the end of 2019.',
      topic: 'vantage-semi',
      saidDate: '2017-11-16',
      targetDate: '2019-12-31',
      hedge: '',
      source: src('Vantage Semi unveiling', '2017-11-16', 'keynote', 'https://www.youtube.com/watch?v=vantagesemi', 912),
      ...graded('correct', 'The first customer deliveries happened in December 2022, three years after the promised date.', {
        resolvedOn: '2022-12-01',
        latenessMonths: 35,
        evidence: [{ url: 'https://trucks.example.com/vantage-semi-first-delivery', title: 'Vantage delivers its first semis', date: '2022-12-01', snippet: 'The first trucks went to a beverage distributor.' }],
      }),
    }),
    make({
      ...MARA,
      type: 'stance',
      quote: "I'm against a robot tax. It punishes the companies that are building the future.",
      claim: 'Mara Quill opposes a tax on companies that deploy robots.',
      topic: 'robot-tax',
      saidDate: '2024-05-14',
      hedge: '',
      specificity: 3,
      source: src('Tech Policy Forum interview', '2024-05-14', 'interview', 'https://policy.example.org/quill-interview'),
    }),
  ];
}

function theoClaims(): Claim[] {
  return [
    make({
      ...THEO,
      quote: 'Probably within five years AI will be better than most professional programmers at most coding tasks.',
      claim: 'AI systems will outperform most professional programmers at most coding tasks by March 2025.',
      topic: 'ai-coding',
      saidDate: '2020-03-02',
      targetDate: '2025-03-02',
      targetDateInferred: true,
      hedge: 'probably',
      impliedProbability: 0.7,
      source: src('Frontier Minds podcast #88', '2020-03-02', 'podcast', 'https://www.youtube.com/watch?v=frontier088', 4410),
      ...graded('partial', 'Top models matched professionals on benchmark coding tasks by early 2025 but not on most real-world engineering work.', {
        evidence: [{ url: 'https://research.example.org/coding-benchmarks-2025', title: 'State of AI coding, spring 2025', date: '2025-04-01' }],
      }),
    }),
    make({
      ...THEO,
      quote: 'I think in twelve months AI writes ninety percent of the code.',
      claim: 'AI will write 90% of all new code by May 2024.',
      topic: 'ai-coding',
      saidDate: '2023-05-10',
      targetDate: '2024-05-10',
      targetDateInferred: true,
      hedge: 'I think',
      impliedProbability: 0.65,
      source: src('Builders Summit fireside chat', '2023-05-10', 'interview', 'https://events.example.com/builders-2023'),
      ...graded('incorrect', 'Industry surveys in mid-2024 put the AI-written share of new code well below half.', {
        evidence: [{ url: 'https://surveys.example.net/dev-survey-2024', title: 'Developer survey 2024', date: '2024-07-15', snippet: 'Respondents estimated 25-30% of their new code was AI-generated.' }],
      }),
    }),
    make({
      ...THEO,
      quote: 'Open models will match GPT-4 within eighteen months. I would bet on it.',
      claim: 'An open-weight model will match GPT-4 on major benchmarks by September 2024.',
      topic: 'open-models',
      saidDate: '2023-03-20',
      targetDate: '2024-09-30',
      targetDateInferred: true,
      hedge: 'bet on it',
      impliedProbability: 0.85,
      source: src('Open Weights newsletter interview', '2023-03-20', 'blog', 'https://openweights.example.com/brandt'),
      ...graded('correct', 'Several open-weight models matched GPT-4 on standard benchmarks by July 2024.', {
        resolvedOn: '2024-07-23',
        evidence: [{ url: 'https://leaderboard.example.org/open-vs-closed', title: 'Open models reach GPT-4 level', date: '2024-07-24' }],
      }),
    }),
    make({
      ...THEO,
      quote: 'Most knowledge workers will use an AI agent every day by 2025.',
      claim: 'Most knowledge workers will use an AI agent daily by the end of 2025.',
      topic: 'ai-agents',
      saidDate: '2024-01-15',
      targetDate: '2025-12-31',
      source: src('Frontier Minds podcast #140', '2024-01-15', 'podcast', 'https://www.youtube.com/watch?v=frontier140', 1260),
      ...graded('unresolvable', 'Surveys disagree on what counts as an agent and on daily use, so the outcome cannot be settled.', {
        disputed: true,
        judges: [
          { judge: 'gpt-5#A', verdict: 'incorrect', confidence: 0.6 },
          { judge: 'gpt-5#B', verdict: 'correct', confidence: 0.55 },
          { judge: 'gpt-5#C', verdict: 'unresolvable', confidence: 0.5 },
        ],
      }),
    }),
    make({
      ...THEO,
      quote: 'By 2030 an AI-discovered drug will be approved by the FDA.',
      claim: 'A drug discovered by AI will receive FDA approval by the end of 2030.',
      topic: 'ai-drug-discovery',
      saidDate: '2025-02-11',
      targetDate: '2030-12-31',
      source: src('BioFuture keynote', '2025-02-11', 'keynote', 'https://biofuture.example.com/keynote-2025'),
      verdict: 'too_early',
      grading: { verdict: 'too_early', confidence: 1, rationale: 'The deadline has not passed yet.', evidence: [], gradedAt: '2026-09-01T00:00:00.000Z', gradedBy: 'rule:deadline' },
    }),
  ];
}

function irisClaims(): Claim[] {
  return [
    make({
      ...IRIS,
      quote: 'I expect inflation to be back under three percent by the end of 2023.',
      claim: 'US CPI inflation will fall below 3% by the end of 2023.',
      topic: 'us-inflation',
      saidDate: '2022-10-04',
      targetDate: '2023-12-31',
      hedge: 'expect',
      impliedProbability: 0.75,
      source: src('Market Hours radio', '2022-10-04', 'interview', 'https://radio.example.com/market-hours/2022-10-04'),
      ...graded('correct', 'Year-over-year CPI inflation fell to 3.0% in June 2023 and stayed near that level.', {
        resolvedOn: '2023-07-12',
        evidence: [{ url: 'https://stats.example.gov/cpi-june-2023', title: 'Consumer prices, June 2023', date: '2023-07-12' }],
      }),
    }),
    make({
      ...IRIS,
      quote: 'A recession in 2023 is likely, I would put it at seventy percent.',
      claim: 'The US economy will enter a recession in 2023.',
      topic: 'us-recession',
      saidDate: '2022-12-01',
      targetDate: '2023-12-31',
      hedge: 'likely',
      impliedProbability: 0.7,
      source: src('Outlook 2023 panel', '2022-12-01', 'keynote', 'https://outlook.example.org/2023-panel'),
      ...graded('incorrect', 'US GDP grew in every quarter of 2023 and no recession was declared.'),
    }),
    make({
      ...IRIS,
      type: 'factual',
      quote: 'Unemployment was three point four percent in January.',
      claim: 'The US unemployment rate was 3.4% in January 2023.',
      topic: 'us-labor-market',
      saidDate: '2023-02-10',
      hedge: '',
      specificity: 5,
      quoteVerified: false,
      origin: 'seed',
      source: src('Market Hours radio', '2023-02-10', 'interview', 'https://radio.example.com/market-hours/2023-02-10'),
    }),
  ];
}

function jonahClaims(): Claim[] {
  return [
    make({
      ...JONAH,
      type: 'stance',
      quote: 'Remote work is here to stay. We are never going back to five days in the office.',
      claim: 'Jonah Pike holds that his company will not return to five office days a week.',
      topic: 'remote-work',
      saidDate: '2021-06-01',
      hedge: '',
      specificity: 3,
      source: src('Future of Work podcast', '2021-06-01', 'podcast', 'https://fow.example.com/ep-31'),
    }),
    make({
      ...JONAH,
      type: 'stance',
      quote: 'Honestly, the office matters. We are going back to five days.',
      claim: 'Jonah Pike holds that his company will return to five office days a week.',
      topic: 'remote-work',
      saidDate: '2025-01-09',
      hedge: '',
      specificity: 3,
      source: src('All-hands memo, published', '2025-01-09', 'blog', 'https://blog.example.com/pike-memo'),
      drift: { label: 'reversed', note: 'Now says the company is returning to five office days, the opposite of the 2021 position.' },
    }),
    make({
      ...JONAH,
      type: 'factual',
      quote: 'We have four hundred people across nine countries.',
      claim: "Jonah Pike's company has about 400 employees in nine countries.",
      topic: 'company-size',
      saidDate: '2021-06-01',
      hedge: '',
      source: src('Future of Work podcast', '2021-06-01', 'podcast', 'https://fow.example.com/ep-31'),
    }),
  ];
}

/** Four fictional people: every verdict kind, a four-deadline robotaxi chain, a goalposts move, a reversal, and one person with no predictions. */
export function sampleLedger(): Ledger {
  const claims = [...maraClaims(), ...theoClaims(), ...irisClaims(), ...jonahClaims()];
  const base: Ledger = { version: 1, updatedAt: '2026-09-27T00:00:00.000Z', claims };
  const labeled = applyDrift(base, detectDrift(base));
  // Model-judged labels the deterministic pass cannot produce.
  for (const c of labeled.claims) {
    if (c.topic === 'vantage-mars-landing' && c.saidDate === '2024-02-01') {
      c.drift = { label: 'goalposts_moved', previousClaimId: c.drift?.previousClaimId, note: 'Target changed from two cargo ships on Mars to a crewed base on the Moon.' };
    }
    if (c.topic === 'remote-work' && c.saidDate === '2025-01-09') {
      c.drift = { label: 'reversed', previousClaimId: c.drift?.previousClaimId, note: 'Now says the company is returning to five office days, the opposite of the 2021 position.' };
    }
  }
  return labeled;
}
