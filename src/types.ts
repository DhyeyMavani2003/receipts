// Shared data model for Receipts. Every module codes against these types.
// The ledger (data/ledger.json) is the rich record; GBrain holds the
// canonical person pages, timeline entries and bet takes derived from it.

import { z } from 'zod';

export const CLAIM_TYPES = ['prediction', 'stance', 'factual'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

// 'pending' = not graded yet. 'too_early' = graded, but the deadline has not
// passed or the outcome is not knowable yet.
export const VERDICTS = ['correct', 'incorrect', 'partial', 'unresolvable', 'too_early', 'pending'] as const;
export type Verdict = (typeof VERDICTS)[number];
export type FinalVerdict = Exclude<Verdict, 'pending'>;

export const DRIFT_LABELS = [
  'first',           // first claim on this topic
  'reaffirmed',      // same claim again, same deadline
  'pushed_later',    // same claim, deadline moved later
  'pulled_earlier',  // same claim, deadline moved earlier
  'goalposts_moved', // the definition of success changed (e.g. Mars -> Moon, AGI redefined)
  'reversed',        // now says the opposite
  'escalated',       // stronger / bigger version of the claim
  'softened',        // weaker / hedged version of the claim
] as const;
export type DriftLabel = (typeof DRIFT_LABELS)[number];

export const SOURCE_KINDS = ['podcast', 'interview', 'x', 'blog', 'earnings_call', 'keynote', 'article', 'other'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourceRef {
  title: string;          // "Tesla Autonomy Day" / "Lex Fridman Podcast #400"
  url: string;            // canonical URL of the episode/post/article
  date: string;           // YYYY-MM-DD the statement was made/published
  kind: SourceKind;
  timestampSec?: number;  // offset of the quote inside the media, if known
  deepLink?: string;      // URL that jumps to the quote (e.g. YouTube &t=123s)
}

export interface EvidenceRef {
  url: string;
  title?: string;
  date?: string;          // YYYY-MM-DD publication date of the evidence
  snippet?: string;       // short supporting excerpt
}

export interface JudgeVote {
  judge: string;          // e.g. "gpt-5#A"
  verdict: FinalVerdict;
  confidence: number;
}

export interface Grading {
  verdict: FinalVerdict;
  confidence: number;             // 0..1, grader's confidence in the verdict
  rationale: string;              // 1-3 sentences, neutral tone
  evidence: EvidenceRef[];        // independent sources, dated after the deadline where possible
  resolvedOn?: string;            // YYYY-MM-DD the outcome became known (for correct-but-late)
  latenessMonths?: number | null; // months after targetDate it came true; null = never happened
  gradedAt: string;               // ISO timestamp
  gradedBy: string;               // model id, or "human:seed" for curated seed rows
  judges?: JudgeVote[];           // individual votes when self-consistency ran
  disputed?: boolean;             // judges disagreed with no majority
}

export interface DriftInfo {
  label: DriftLabel;
  previousClaimId?: string;
  note: string;                   // one neutral sentence, e.g. "Deadline moved from 2018 to 2022."
  labeledBy?: string;             // who chose a judgment label: model id, or "human:..." for hand labels; absent = code
}

export interface GBrainLink {
  page: string;                   // "people/elon-musk"
  row?: number;                   // takes-fence row number once written
  timelineWritten?: boolean;
  resolvedQuality?: string;       // what we last pushed to `gbrain takes resolve`
}

export interface Claim {
  id: string;                     // stable id, see ledger.claimId()
  person: string;                 // display name, "Elon Musk"
  personSlug: string;             // "elon-musk" (GBrain holder = people/<slug>)
  quote: string;                  // verbatim words as spoken/written
  quoteVerified: boolean;         // true once matched against the transcript or a cited source
  claim: string;                  // normalized, standalone, checkable restatement
  type: ClaimType;
  topic: string;                  // kebab-case topic key, e.g. "tesla-robotaxi", "mars-landing", "agi-timeline"
  saidDate: string;               // YYYY-MM-DD
  targetDate?: string;            // YYYY-MM-DD deadline by which it should resolve
  targetDateInferred?: boolean;   // true when the deadline was inferred, not stated
  resolutionCriteria: string;     // what observable outcome makes it true
  hedge: string;                  // the hedge phrase used ("for sure", "I think", "" if none)
  impliedProbability: number;     // 0.05..0.95 in 0.05 steps, from hedge.ts (never from the LLM)
  specificity: number;            // 1 (vague) .. 5 (precise number + date)
  source: SourceRef;
  verdict: Verdict;
  grading?: Grading;
  drift?: DriftInfo;
  gbrain?: GBrainLink;
  origin: 'seed' | 'extracted';
  extractedAt?: string;           // ISO timestamp
}

export interface Ledger {
  version: 1;
  updatedAt: string;
  claims: Claim[];
}

// ---- Transcripts -------------------------------------------------------

export interface Segment {
  start?: number;                 // seconds from the start of the media
  speaker?: string;               // speaker label when the source has one
  text: string;
}

export interface Transcript {
  text: string;                   // segments joined with single spaces/newlines
  segments: Segment[];
  meta: Partial<SourceRef> & { channel?: string; durationSec?: number };
}

// ---- Scores ------------------------------------------------------------

export interface TopicScore {
  topic: string;
  predictions: number;
  correct: number;
  incorrect: number;
  partial: number;
  accuracy: number | null;        // correct / (correct + incorrect)
}

export interface PersonScore {
  personSlug: string;
  person: string;
  claims: number;                 // all claim types
  predictions: number;
  correct: number;
  incorrect: number;
  partial: number;
  unresolvable: number;
  tooEarly: number;
  pending: number;
  accuracy: number | null;        // correct / (correct + incorrect), same as GBrain scorecard
  creditAccuracy: number | null;  // (correct + 0.5*partial) / (correct + incorrect + partial)
  brier: number | null;           // mean (p - outcome)^2 over correct/incorrect, same as GBrain
  latenessMultiplier: number | null; // median (actual - said) / (target - said) over late-but-true
  driftEvents: number;            // claims labeled pushed_later | goalposts_moved | reversed
  byTopic: TopicScore[];
  calibration: { bucket: string; n: number; predicted: number; observed: number }[];
}

// ---- Discovery and following ------------------------------

export const TRANSCRIPT_SOURCES = ['youtube', 'page', 'audio', 'unknown'] as const;
export type TranscriptSource = (typeof TRANSCRIPT_SOURCES)[number];

export interface Candidate {
  title: string;              // episode or talk title as published
  show: string;               // podcast / channel / event, e.g. "All-In Podcast"
  host?: string;              // interviewer, when one person hosts
  date: string;               // YYYY-MM-DD published; '' when unknown
  url: string;                // canonical http(s) URL, signed params stripped
  kind: SourceKind;           // podcast | interview | keynote | earnings_call | blog | article | other (never 'x')
  durationMin?: number;
  transcriptSource: TranscriptSource;
  why: string;                // one neutral sentence: what they talk about
  linkConfirmed: boolean;     // URL was among the web search's cited or read pages
}

export type CandidateStatus = 'new' | 'pulling' | 'pulled' | 'failed' | 'have';

export interface DiscoveredCandidate extends Candidate {
  status: CandidateStatus;
  foundAt: string;            // ISO
  pulledAt?: string;          // ISO
  receipts?: number;          // claims added by the pull
  error?: string;             // short, user-safe
}

export interface WatchPerson {
  name: string;               // display name as the user typed it, title-cased
  slug: string;               // slugify(name)
  followedAt: string;         // ISO
  lastCheckedAt?: string;     // ISO, last discovery run
  aliases?: string[];         // extra names the resolver accepts ("Zuck")
}

export interface Watchlist {
  version: 1;
  people: WatchPerson[];
}

export interface DiscoveryRecord {
  checkedAt: string;          // ISO
  since: string;              // YYYY-MM-DD window start used
  candidates: DiscoveredCandidate[];
}

export interface DiscoveryStore {
  version: 1;
  bySlug: Record<string, DiscoveryRecord>;
}

// ---- Zod schemas for model output ---------------------------------------
// Model output schemas live next to the prompts (extract.ts, grade.ts,
// drift.ts, ask.ts). They must be representable in OpenAI strict JSON
// schema: every property required (use nullable instead of optional), no
// unions of objects, no min/max on numbers.

export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---- Routing and natural-language ask ------------------

export type RouteKind = 'pull' | 'follow' | 'unfollow' | 'discover' | 'person' | 'ask';

export interface Route {
  kind: RouteKind;
  text: string;                  // the input, trimmed
  url?: string;                  // pull
  speaker?: string;              // pull: resolved or typed name
  name?: string;                 // follow / unfollow / discover / person: canonical or typed name
  slug?: string;                 // when the name is a known person
  via: 'rule' | 'model';
}

export type QuestionKind =
  | 'track_record'   // trust, reliable, accurate, track record, believe
  | 'drift'          // changed, tune, mind, flip, shift, evolve, moved, backtrack, still think, over time
  | 'contradiction'  // contradict, inconsistent, opposite, both ways
  | 'said_about'     // what did X say/think about Y, X's view/take on Y
  | 'compare'        // two or more people, or vs / versus / compare / who is more
  | 'ranking'        // who has been most right / wrong / accurate, best, worst
  | 'due'            // coming due, due, deadline, upcoming, should resolve
  | 'recent'         // new, latest, lately, recently, this week
  | 'general';

export interface TimeWindow { from?: string; to?: string; field: 'saidDate' | 'targetDate'; label: string }

export interface QuestionPlan {
  kind: QuestionKind;
  people: string[];              // slugs, order of mention
  unknownNames: string[];        // name-like spans that match no known person
  terms: string[];               // stemmed topic words (questionKeywords)
  topics: string[];              // ledger topic keys the terms hit
  window?: TimeWindow;
  polarity?: 'right' | 'wrong';  // ranking direction
}

export interface CitedReceipt {
  id: string; person: string; personSlug: string; saidDate: string; quote: string; claim: string;
  type?: ClaimType;              // absent on old recordings; treated as a prediction
  verdict: Verdict; targetDate?: string; sourceTitle: string; sourceUrl: string; deepLink?: string;
}

export type SuggestedAction =
  | { type: 'follow'; name: string; label: string }
  | { type: 'discover'; slug: string; name: string; label: string }
  | { type: 'open'; slug: string; label: string };

export interface AnswerResult {
  question: string;
  kind: QuestionKind;
  answer: string;
  receipts: CitedReceipt[];      // what the answer cites, in answer order
  people: string[];              // slugs
  followUps: string[];           // 0..3 questions the ledger can answer
  actions: SuggestedAction[];
  usedModel: boolean;
  fromRecording: boolean;        // model answer came from a fixture (model id starts with replay:)
  note?: string;
}
