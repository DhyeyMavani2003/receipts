---
name: receipts-grade
version: 1.0.0
description: |
  Grade a public figure's predictions once their deadline has passed. Finds due
  `bet` takes, looks for independent evidence dated after the deadline, reaches
  a verdict (correct, incorrect, partial, unresolvable) with a strict and a
  charitable reading plus a tie-break, records it with `gbrain takes resolve`,
  and refreshes the person's track record and GBrain scorecard.
triggers:
  - "grade the predictions"
  - "which predictions came due"
  - "did that prediction come true"
  - "score the due bets"
  - "resolve the due predictions"
  - "receipts grade"
tools:
  - get_page
  - put_page
  - takes_list
  - takes_resolve
  - takes_scorecard
  - web_search
mutating: true
writes_pages: true
writes_to:
  - people/
---

# receipts-grade: close the loop on predictions

When a prediction's deadline passes, find out what actually happened, from
sources the speaker does not control, and record the verdict in GBrain so the
person's scorecard (accuracy and Brier) stays current.

## Non-negotiables

1. **Verbatim quote + link on every claim.** A verdict is attached to a claim
   that already has its exact quote and source link. Never grade a claim that
   lacks them; send it back through receipts-ingest.
2. **Holder = the speaker, not the subject.** Resolve the take on the
   speaker's page (`people/<slug>`). A verdict is about what the speaker said,
   not about the company or topic they talked about.
3. **Hedge → probability is fixed at ingest.** Never change a take's weight
   after the fact to make the Brier score look better or worse. The table is
   below for reference.
4. **Independent evidence only.** The speaker's own later statements, their
   company's marketing, and self-grading ("I was right", "we basically did
   it") are not evidence. Prefer primary sources (filings, official data,
   regulators) and credible reporting dated after the deadline.
5. **Neutral tone.** Verdicts are a track record on public statements. Write
   "the prediction did not come true by the deadline", never "he lied".
6. **Unresolvable is allowed.** If independent evidence cannot settle it, the
   verdict is `unresolvable`. That is a legitimate outcome, not a failure.

## Hedge → probability table

The weight on each bet was set at ingest from the speaker's hedge words
(longest phrase wins, 0.05 steps, clamped to [0.05, 0.95]). Brier compares
this weight with the outcome; 0.25 is the always-50% coin-flip baseline.

| p | hedge phrases |
|------|---------------|
| 0.95 | for sure, definitely, certainly, guarantee, 100%, no doubt, absolutely, without question, completely obvious |
| 0.90 | very confident, highly confident, extremely likely, I'm confident, feel confident |
| 0.85 | plain future declarative: will, is going to, or no hedge at all |
| 0.75 | very likely, expect, on track, fairly confident, the plan is, game plan |
| 0.70 | likely, probably, should |
| 0.65 | I think, I believe, my guess, I'm guessing, I guess |
| 0.55 | I hope, hopefully, our hope is, aim to, goal is, aspirational, see if we can |
| 0.50 | 50/50, coin flip, maybe |
| 0.40 | possibly, potentially, could, might, we may, it may, may see |
| 0.25 | unlikely, doubt (about the event; a claim written as "X will not" gets 1 − p) |
| 0.10 | no chance, never going to (about the event; a claim written as "X will not" gets 1 − p) |

## Verdicts

| verdict | meaning | GBrain |
|---------|---------|--------|
| correct | the claim as stated happened by the deadline | `--quality correct` |
| incorrect | it did not happen, or the opposite happened | `--quality incorrect` |
| partial | a material part happened, or it happened in a clearly smaller form | `--quality partial` |
| unresolvable | independent evidence cannot settle it, or judges could not agree | `--quality unresolvable` |
| too_early | the deadline has not passed or the outcome is not knowable yet | do not resolve |

Came true, but late? Record `resolvedOn` (the date it actually happened). The
strict reading treats a missed hard deadline as `incorrect`; the charitable
reading may call it correct-but-late. The engine reports lateness as a
multiplier (2.5× = took 2.5 times as long as promised) so the delay stays
visible either way.

## Decide the path

Run `receipts doctor` (or `bun <receipts>/src/cli.ts doctor`). Exit code 0 →
fast path. Otherwise → manual path.

## Fast path: the Receipts engine

```bash
receipts grade [--person <slug>] [--limit N] [--judges 1|2|3] [--regrade]
receipts score --person <slug>
```

- Grades every prediction with `targetDate <= today` that is still pending or
  too early. Future deadlines become `too_early` without a model call.
- Two judges by default: A reads the claim's wording strictly, B reads the
  speaker's intent charitably. They agree → that verdict. They disagree →
  judge C breaks the tie. Still no majority → `unresolvable`, marked disputed.
- Every judge uses web search and must cite independent evidence; evidence is
  merged (max 5 links) into the ledger. Only URLs a judge names count: pages
  its search merely read are not evidence. An outcome verdict with no such URL
  is not recorded, so the claim stays pending. Unresolvable and disputed
  verdicts store no links.
- Resolutions are pushed to GBrain (`takes resolve`) and the track-record
  block on the person page is refreshed. `--no-gbrain` skips that.
- `--regrade` revisits graded claims in the ledger. GBrain resolutions are
  immutable, so a changed verdict stays in the ledger and is reported, not
  rewritten in the brain.

## Manual path: GBrain tools only

### 1. Find due bets

```bash
gbrain takes people/<slug> --kind bet --json
```

A row is due when `resolved_quality` is null and the `(deadline YYYY-MM-DD)`
at the end of its claim is on or before today. Deadline in the future →
`too_early`: tell the user and leave the row alone.

### 2. Gather independent evidence

For each due bet, search the web for what happened. Keep 1–5 sources with
URL, title, date and a one-line snippet. Prefer sources dated after the
deadline. Discard the speaker's own later claims, their company's PR, and any
page that only repeats the prediction.

### 3. Reach a verdict (two readings + tie-break)

- **A, strict:** does the claim, read literally, match the outcome by the
  deadline?
- **B, charitable:** does the speaker's evident intent match the outcome?
- A and B agree → that verdict. Disagree → **C** re-reads the evidence and
  picks one. No majority → `unresolvable` (disputed).
- Write a 1–3 sentence neutral rationale that cites the evidence.

### 4. Record the verdict in GBrain

```bash
gbrain takes resolve people/<slug> --row <N> --quality <correct|incorrect|partial|unresolvable> \
  --evidence "<best evidence url>" --by receipts
```

Resolutions are immutable. If the row is already resolved with a different
quality, do not retry; tell the user the brain keeps the first verdict.

### 5. Refresh the track record

```bash
gbrain takes scorecard people/<slug> --json
```

Then update the block on the person page between
`<!-- receipts:track-record:begin -->` and `<!-- receipts:track-record:end -->`
(insert it right after the H1 and summary, above the timeline, if missing):

1. `gbrain get people/<slug> --include-content --json` → keep `content` and `revision`.
2. Replace only the text between the two markers; leave every other byte as is.
3. Write it back with `gbrain put people/<slug> --expected-revision <revision>`
   (content on stdin). A revision conflict means the page changed: re-read and retry.

Block contents: accuracy (correct / (correct + incorrect)) with n, Brier vs the
0.25 baseline, partial and unresolvable counts, pending count, and one line per
newly graded bet: verdict, deadline, quote, evidence link.

## Output format

```
Graded 3 due predictions for <Name>:
- INCORRECT     due 2020-12-31  "<verbatim quote>" ▶ <quote link>
  Evidence: <url> (<date>). <one neutral sentence on what happened by the deadline>
- CORRECT       due 2021-12-31  "<verbatim quote>" ▶ <quote link>
  Evidence: <url> (<date>). <rationale>
- UNRESOLVABLE  due 2022-06-30  "<verbatim quote>" ▶ <quote link>  (judges disagreed)
Scorecard: 4/9 correct (44%), Brier 0.41 vs 0.25 coin-flip baseline, 2 unresolvable.
```

## Anti-patterns

- Grading from memory or training data instead of live, dated sources.
- Counting the speaker's "we did it" tweet as evidence.
- Forcing correct/incorrect when the evidence is thin; use `unresolvable`.
- Resolving a bet whose deadline has not passed.
- Editing a take's weight or claim text after the outcome is known.
- Loaded words ("lied", "failed again") in the rationale.
