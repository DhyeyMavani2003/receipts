---
name: receipts-ingest
version: 1.0.0
description: |
  Turn a podcast episode, interview, keynote, earnings call or post into dated,
  verbatim-quoted claims on the speaker's GBrain person page: one timeline entry
  per claim, one take per claim (predictions become `bet` takes weighted by the
  speaker's hedge words). Every claim carries the exact quote and a link to the
  moment it was said. Quotes that do not string-match the source are dropped.
triggers:
  - "pull receipts from"
  - "log the predictions in"
  - "extract the claims from this"
  - "add this episode to receipts"
  - "what did they predict in this"
  - "receipts ingest"
tools:
  - search
  - get_page
  - put_page
  - add_timeline_entry
  - takes_list
  - takes_add
mutating: true
writes_pages: true
writes_to:
  - people/
---

# receipts-ingest: media in, receipts out

Take one source (YouTube URL, podcast transcript, article, post) and one
speaker, and write every checkable claim that speaker made into their GBrain
person page, with the verbatim quote, the date and a link to the moment.

## Non-negotiables

1. **Verbatim quote + link on every claim.** The quote is copied from the
   transcript, never paraphrased or reconstructed from memory. It must
   string-match the source (case, punctuation and filler words like "uh",
   "um", "you know" aside). No match, no claim: drop it and say why. Every
   claim links to the source, with a timestamp deep link when there is one.
2. **Holder = the speaker, not the subject.** A prediction Elon Musk makes
   about Tesla is held by `people/elon-musk` and filed on `people/elon-musk`,
   never on `companies/tesla`. The host's questions are not claims. Words the
   speaker quotes from someone else are not the speaker's claims. A repost or
   "as X said" is amplification, not endorsement.
3. **Hedge → probability comes from the table below**, never from vibes and
   never from the model's own belief about the outcome.
4. **Independent evidence only** (grading happens later in receipts-grade):
   the speaker's own later statements and self-grading ("I was right") are not
   evidence. At ingest time, record what was said; do not grade it.
5. **Neutral tone.** This is a track record on public statements. Never write
   "lied", "liar", "fraud" or similar. Restate claims plainly.
6. **Unresolvable is allowed.** A claim with no checkable outcome is either
   skipped at ingest (fails the "could a neutral person check this?" test) or
   graded `unresolvable` later. Never force a verdict.

## Hedge → probability table

Match the hedge words the speaker used near the claim, case-insensitive; the
longest matching phrase wins. Round to the nearest 0.05 and clamp to
[0.05, 0.95]. Use 0.05 steps only (0.65, not 0.67).

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

The table gives the probability the speaker assigns to the **event**. A GBrain
take's weight is the holder's confidence in the claim **as written**. So when
the speaker bets against an event ("unlikely", "doubt", "no chance", "never
going to"), write the claim in the speaker's direction and use 1 − p:
"There's no chance Apple ships a car by 2025" → claim "Apple will not ship a
car by 2025", weight 0.90. That keeps GBrain's accuracy and Brier honest.

## Decide the path

Run `receipts doctor` (or `bun <receipts>/src/cli.ts doctor`, where
`<receipts>` is the directory the Receipts engine is cloned into). Exit code 0
→ use the fast path. Engine missing or broken → use the manual path. Both
produce the same GBrain rows.

## Fast path: the Receipts engine

```bash
receipts ingest "<file|url>" --speaker "<Full Name>" [--host "<Host Name>"] \
  [--title "<Episode title>"] [--date YYYY-MM-DD] [--url "<canonical url>"] [--kind podcast]
```

- Accepts YouTube URLs (captions via yt-dlp), other web pages, local
  `.txt/.md/.vtt/.srt/.json` transcripts and audio files.
- Extracts claims, drops quotes that fail the string match (and reports them),
  assigns hedge probabilities in code, writes the ledger, syncs GBrain
  (person page, timeline entries, takes), grades any predictions already past
  their deadline, and labels drift.
- `--dry-run` shows the claims without writing anything. `--no-gbrain` skips
  the brain sync. `--no-grade` skips grading. `--offline` uses recorded
  model fixtures.
- Always pass `--speaker`. Pass `--host` for interviews so the host's
  questions are never attributed to the guest.

Then show the user what landed: `receipts score --person <slug>`.

## Manual path: GBrain tools only

Use this when the engine is not installed. `<slug>` is the speaker's name in
kebab case ("Elon Musk" → `elon-musk`).

### 1. Get the words

Get the full transcript or text: captions, a published transcript, or the
article body. If you cannot get the actual words, stop and tell the user.
Never extract claims from a summary or from memory. Note the publish date
(YYYY-MM-DD), title, canonical URL and, for video, each line's timestamp.

### 2. Extract claims (speaker only)

Read the whole source. For every statement **by the speaker**:

- **Atomic:** split compound claims ("X by June and Y by December" → two).
- **Standalone:** resolve names, pronouns and relative dates. "Next year",
  said on 2019-04-22 → deadline 2020-12-31. "In 3 to 6 months" → said date +
  6 months. Mark inferred deadlines as inferred.
- **Type:** `prediction` (about the future, checkable later), `stance` (a
  position that can drift), `factual` (a checkable fact about the present or
  past).
- **Checkable:** skip anything that fails "could a neutral person check this?"
- **Resolution criteria:** one observable outcome that makes it true.
- **Topic:** a short kebab key reused across episodes (`tesla-robotaxi`,
  `mars-landing`, `agi-timeline`). Check the person's existing takes first
  (`gbrain takes people/<slug> --json`) and reuse their topic words so drift
  chains form.
- **Quote:** copy the exact words. Then search the transcript for them. If
  the quote is not there (ignoring case, punctuation and filler words), drop
  the claim and list it under "dropped" with the reason.
- **Link:** the canonical URL; for YouTube add `&t=<seconds>s` (or `?t=` on
  youtu.be links) at the quote's timestamp.

### 3. Skip duplicates

`gbrain takes people/<slug> --json` lists existing rows. Skip any claim whose
text, deadline and source already exist on the page.

### 4. Make sure the person page exists

`gbrain get people/<slug>` exits non-zero when the page is missing. Create it
(create-only; this never overwrites):

```bash
cat <<'EOF' | gbrain put people/<slug>
---
type: person
title: <Full Name>
tags: [receipts]
---
# <Full Name>

> Public figure tracked by Receipts: a track record on public statements.

## State
[No data yet]

## What They Believe
[No data yet]

## Hobby Horses
[No data yet]

## Open Threads
[No data yet]
EOF
```

Do not add a `## Timeline` heading yourself. GBrain creates and owns the
timeline section on the first `timeline-add`.

### 5. Write one timeline entry per claim

```bash
gbrain timeline-add people/<slug> <saidDate> \
  '<Source title> — "<verbatim quote>" <deep link or url>' \
  --detail 'receipts: type=<type> topic=<topic> due=<targetDate|none> hedge="<hedge>" p=<p>'
```

Put the link inside the summary. Do not pass the URL to `--source`: on the
CLI that flag selects a brain source id and rejects URLs.

### 6. Write one take per claim

```bash
gbrain takes add people/<slug> \
  --claim "<normalized claim> (deadline <targetDate>)" \
  --kind bet --who people/<slug> --weight <p> \
  --source "<Source title> <saidDate> <url>" --since <YYYY-MM of saidDate>
```

- `prediction` → `--kind bet` with the `(deadline YYYY-MM-DD)` suffix.
- `stance` → `--kind take`; `factual` → `--kind fact` (self-reported, so the
  holder is still the speaker, never `world`).
- `--who` is always `people/<speaker-slug>`, the page is the speaker's page.
- Keep `|` out of claim text; it breaks the takes table.
- Note the row number from "Added take #N". receipts-grade needs it.

### 7. Report

Tell the user: source title and date, N claims written (predictions, stances,
facts), each with its quote, deadline and weight, plus every dropped quote and
why. Offer receipts-grade for any prediction whose deadline has already
passed.

## Output format

```
Ingested "<title>" (<date>) for <Name>: 7 claims (4 predictions, 2 stances, 1 fact), 1 dropped.
- [bet p=0.95, due 2020-12-31] "<verbatim quote>" ▶ <deep link>
- [take p=0.65] "<verbatim quote>" ▶ <deep link>
Dropped: "<quote>" (not found in transcript)
```

## Anti-patterns

- Paraphrasing a quote, or "cleaning up" the speaker's grammar inside it.
- Attributing the host's question, or someone the speaker quoted, to the speaker.
- Filing a claim on the subject's page (`companies/tesla`) instead of the speaker's.
- Picking a weight from your own sense of how likely the event is.
- Grading at ingest time, or writing "this was wrong" into the take.
- Re-running on the same source without the duplicate check.
