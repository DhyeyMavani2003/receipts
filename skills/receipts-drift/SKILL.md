---
name: receipts-drift
version: 1.0.0
description: |
  Show how a public figure's story changes over time on one topic: line up every
  dated, quoted claim on that topic, detect deadline slips in code (pushed later
  or pulled earlier by 60+ days), and label the judgment calls (goalposts moved,
  reversed, escalated, softened) with a neutral one-sentence note per step.
triggers:
  - "how has their story changed"
  - "did they move the goalposts"
  - "show the deadline drift"
  - "show how the timeline slipped"
  - "has the deadline been pushed"
  - "receipts drift"
tools:
  - get_page
  - put_page
  - get_timeline
  - takes_list
mutating: true
writes_pages: true
writes_to:
  - people/
---

# receipts-drift: how the story moves

A single missed prediction says little. The same promise restated every year
with a new deadline says a lot. This skill builds per-topic chains of a
person's claims and labels each step, so the user can see
"2018 → 2022 → 2026 → a self-growing city on the Moon" with a receipt behind
every arrow.

## Non-negotiables

1. **Verbatim quote + link on every claim.** Every step in a chain shows the
   exact quote, the date it was said and the source link. A step without a
   receipt is left out of the chain.
2. **Holder = the speaker, not the subject.** A chain belongs to one speaker.
   Never merge two people's claims about the same subject into one chain.
3. **Hedge → probability comes from the table below.** A change in hedge
   words (from "definitely" at 0.95 to "I hope" at 0.55) is evidence of
   `softened`; the reverse is `escalated`.
4. **Independent evidence only.** Drift compares what the speaker said with
   what the speaker said before. Whether the claim came true is
   receipts-grade's job, with independent sources.
5. **Neutral tone.** Notes describe, they do not accuse: "Deadline moved from
   2018 to 2022.", never "keeps lying about the date".
6. **Unresolvable is allowed.** If two statements are too vague to compare,
   label the later one `reaffirmed` only when it clearly repeats the claim;
   otherwise leave it out of the chain and say so.

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

## Drift labels

| label | decided by | meaning |
|-------|-----------|---------|
| first | code | first claim on this topic |
| reaffirmed | code | same claim again, deadline within 60 days of the previous one |
| pushed_later | code | same claim, deadline moved 60+ days later |
| pulled_earlier | code | same claim, deadline moved 60+ days earlier |
| goalposts_moved | judgment | the definition of success changed (Mars → Moon, AGI redefined) |
| reversed | judgment | now says the opposite |
| escalated | judgment | a stronger or bigger version of the claim |
| softened | judgment | a weaker or more hedged version of the claim |

Date slips are arithmetic, so code decides `pushed_later` and
`pulled_earlier`; judgment cannot overrule a measured slip. Judgment may only
upgrade a step to `goalposts_moved`, `reversed`, `escalated` or `softened`.

## Decide the path

Run `receipts doctor` (or `bun <receipts>/src/cli.ts doctor`). Exit code 0 →
fast path. Otherwise → manual path.

## Fast path: the Receipts engine

```bash
receipts drift [--person <slug>] [--no-llm] [--relabel]
receipts site [--out out/site]
```

- Builds topic chains from the ledger, applies the deterministic slip labels,
  then asks the model to label the judgment transitions (skip that with
  `--no-llm`; offline runs keep the deterministic labels only).
- The seed's curated labels are kept: chains made only of seed claims take
  their labels from the curated fixtures, with no model call. `--relabel`
  lets the model redo them.
- The person page in the generated site renders each chain as dated deadline
  pills; `receipts serve` shows the same pages live.
- `receipts score --person <slug> --json` includes `driftEvents` (steps
  labeled pushed_later, goalposts_moved or reversed).
- `receipts sync --person <slug>` writes the chains into the track-record
  block on the GBrain person page.

## Manual path: GBrain tools only

### 1. Collect the person's claims

```bash
gbrain takes people/<slug> --json
gbrain timeline people/<slug>
```

Takes give the normalized claim, kind, weight, `since_date` and the
`(deadline YYYY-MM-DD)` suffix on bets. Timeline entries give the verbatim
quote and link for each statement (same date, same source title).

### 2. Group into topic chains

Group claims about the same subject (same product, same milestone, same
forecast) and sort each group by the date said. A chain needs at least two
claims to show drift; a single claim is labeled `first`.

### 3. Label each step

For each claim after the first, compare with the previous one in the chain:

1. Both have deadlines and the new one is 60+ days later → `pushed_later`;
   60+ days earlier → `pulled_earlier`; otherwise `reaffirmed`.
2. Then read both quotes. If the success condition changed, the stance
   flipped, or the claim got clearly bigger or clearly more hedged, upgrade
   to `goalposts_moved`, `reversed`, `escalated` or `softened`.
3. Write one neutral sentence per step: "Deadline moved from 2019-12-31 to
   2020-12-31." / "Target changed from a Mars landing to a Moon landing."

### 4. Record it (optional, only when the user wants it saved)

Add the chains to the track-record block on the person page between
`<!-- receipts:track-record:begin -->` and `<!-- receipts:track-record:end -->`:
`gbrain get people/<slug> --include-content --json`, replace only the text
between the markers, then
`gbrain put people/<slug> --expected-revision <revision>` with the new content on stdin.

Never `takes supersede` an older bet because the person restated it. Each
statement is its own receipt and is graded on its own deadline.

## Output format

```
<Name> on <topic> (4 statements, deadline pushed 2 times):
2019-04-22  due 2020-12-31  first            "<verbatim quote>" ▶ <link>
2020-07-09  due 2021-12-31  pushed_later     "<verbatim quote>" ▶ <link>  Deadline moved from 2020-12-31 to 2021-12-31.
2022-01-26  due 2022-12-31  pushed_later     "<verbatim quote>" ▶ <link>  Deadline moved from 2021-12-31 to 2022-12-31.
2024-04-23  due 2024-08-08  goalposts_moved  "<verbatim quote>" ▶ <link>  Target changed from <old goal> to <new goal>.
Chain: 2020 → 2021 → 2022 → <new goal>
```

## Anti-patterns

- Letting judgment call something `pushed_later` when the dates did not move 60+ days.
- Chaining two different claims because they share a keyword.
- Mixing claims from two speakers into one chain.
- Writing motive into the note ("to pump the stock").
- Superseding or deleting earlier takes when a new statement arrives.
