---
name: receipts-ask
version: 1.0.0
description: |
  Answer "how much should I trust <person> on <topic>?" from the user's own brain:
  the person's GBrain takes scorecard (accuracy, Brier vs the 0.25 coin-flip
  baseline, unresolvable rate), the topic-specific subset, any deadline drift, and
  two or three dated receipts with verbatim quotes and links. States uncertainty
  plainly and never invents a claim that is not in the brain.
triggers:
  - "how much should i trust"
  - "what's their track record on"
  - "show me the receipts on"
  - "is this person reliable on"
  - "how accurate are their predictions"
  - "receipts ask"
tools:
  - search
  - get_page
  - get_timeline
  - takes_list
  - takes_search
  - takes_scorecard
  - takes_calibration
mutating: false
writes_pages: false
---

# receipts-ask: should I trust this person on this?

Answer with numbers and receipts, not adjectives. The user asked a judgment
question; give them the evidence to make the judgment themselves, in under
150 words.

## Non-negotiables

1. **Verbatim quote + link on every claim you cite.** Each receipt in the
   answer has the date said, the exact quote in quotation marks, and the link.
   Cite only claims that exist in the brain (or the Receipts ledger). Never
   invent, paraphrase into quotes, or fill gaps from memory.
2. **Holder = the speaker, not the subject.** "How much should I trust Elon on
   Tesla?" is about claims held by `people/elon-musk`, not about Tesla's
   results. Do not count other people's claims about the person.
3. **Hedge → probability** set the weights the Brier score is computed from
   (table below). Brier below 0.25 beats a coin flip at the stated confidence;
   above 0.25 means the stated confidence ran ahead of outcomes.
4. **Independent evidence only.** A verdict counts only if it was graded
   against independent sources. The person's own claims of success do not
   change the record.
5. **Neutral tone.** Say "track record on public statements". Never "liar",
   "can't be trusted", "fraud". Let the numbers and quotes speak.
6. **Unresolvable is allowed, and so is "not enough data".** Fewer than 5
   resolved predictions on the topic → say the record is too thin to judge.
   Report the unresolvable count; do not drop it.

## Hedge → probability table

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

## Decide the path

Run `receipts doctor` (or `bun <receipts>/src/cli.ts doctor`). Exit code 0 →
fast path. Otherwise → manual path.

## Fast path: the Receipts engine

```bash
receipts ask "how much should I trust <Name> on <topic>?"
receipts score --person <slug> --json
```

- `ask` finds the person, pulls their score, the topic-relevant claims with
  verdicts and quotes, and writes a cited answer (≤150 words). With no model
  available it prints a deterministic answer from the scores and the top 3
  receipts.
- `score --json` gives accuracy, credit accuracy (partial = half), Brier,
  lateness multiplier, pending count, drift events, per-topic accuracy and
  calibration buckets. Use it to double-check the numbers you quote.
- If the question carries a new claim ("they say X by next year, should I
  believe it?"), `ask` may search the web for that claim; the verdicts in the
  answer still come only from the ledger.

## Manual path: GBrain tools only

### 1. Find the person

`gbrain search "<name>"` → the `people/<slug>` page. No page, or no takes on
it → say there are no receipts yet and offer receipts-ingest on a source.

### 2. Overall scorecard

```bash
gbrain takes scorecard people/<slug> --json
```

Fields: `total_bets`, `resolved`, `correct`, `incorrect`, `partial`,
`accuracy` (correct / (correct + incorrect)), `brier` (correct and incorrect
only; 0.25 = always-50% baseline), `unresolvable_count`, `unresolvable_rate`.
Optional: `gbrain takes calibration people/<slug> --json` for the curve.

### 3. The topic subset

```bash
gbrain takes people/<slug> --kind bet --json
```

Keep the rows whose claim is about the asked topic;
`gbrain takes search "<topic words>"` helps find them. Count correct, incorrect, partial,
unresolvable and still-open rows; topic accuracy = correct / (correct +
incorrect). Also note deadline drift on the topic (see receipts-drift): how
many times the same promise was restated with a later date.

### 4. Pick the receipts

Choose 2–3 resolved bets on the topic, mixing hits and misses when both
exist. For each, get the verbatim quote and link from
`gbrain timeline people/<slug>` (same date as the take's source) and the evidence link from
the take's `resolved_source`.

### 5. Answer (≤150 words)

1. One-line bottom line with the numbers and n: "On <topic>, 2 of 7 graded
   predictions came true by their deadline (29%); overall 11 of 30 (37%),
   Brier 0.38 vs 0.25 coin-flip."
2. The receipts: date said, "verbatim quote", deadline, verdict, links.
3. Drift, if any: "The deadline for <topic> has moved 3 times since 2019."
4. Uncertainty: sample size, pending and unresolvable counts, that verdicts
   are AI-assisted and link their evidence.
5. A practical read: how to weigh the person's next claim on this topic (for
   example, "discount stated timelines; the direction has often been right").

## Output format

```
On <topic>, <Name> is 2/7 on graded predictions (29%), Brier 0.41 vs a 0.25 coin-flip baseline; 3 more are pending.
- 2019-04-22: "<verbatim quote>" (due 2020-12-31) → INCORRECT. <quote link> · evidence <url>
- 2021-02-10: "<verbatim quote>" (due 2021-12-31) → CORRECT. <quote link> · evidence <url>
The <topic> deadline has been restated 3 times, each later. Small sample; verdicts are AI-assisted and each links its evidence.
Read: the direction has held up more often than the dates.
```

## Anti-patterns

- An answer with adjectives and no numbers, or numbers without n.
- Quoting from memory, or citing a claim that is not in the brain.
- Mixing up the topic subset with the overall record.
- Hiding unresolvable or pending predictions.
- Character judgments ("he's a liar", "never trust her").
