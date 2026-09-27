# Bootstrap: Receipts

Post-scaffold steps. gbrain displays this but does NOT auto-execute it. The
agent reads each step and runs what it understands, asking the user where a
step says so. Nothing here deletes or overwrites existing pages.

The four skills (receipts-ingest, receipts-grade, receipts-drift,
receipts-ask) work with gbrain alone. The optional Receipts engine (a small
Bun CLI) adds transcript loading, quote verification, multi-judge grading and
a static site on top of the same GBrain rows.

1. show user: "Receipts is installed. It turns podcasts and interviews into dated, verbatim-quoted predictions on each speaker's person page, grades them when they come due, and answers 'how much should I trust X on Y?'. Try: 'pull receipts from <youtube url>, speaker <Name>'."
2. agent: `gbrain --version` must print 0.59.0 or later (the skills use `takes add --kind bet`, `takes resolve --quality ... unresolvable`, `takes scorecard --json` and `timeline-add --detail`). If older, suggest `gbrain upgrade`.
3. agent: `gbrain takes scorecard --json` confirms the takes table is reachable. An empty scorecard is fine on a new brain.
4. ask user: "Do you want the Receipts engine too? It needs Bun 1.3+ and an OpenAI API key for live extraction and grading; without it the skills fall back to plain gbrain commands."
5. agent: If the user said yes, clone the Receipts repo (see the pack's homepage), then in that directory run `bun install`. Call that directory `<receipts>`; `bun <receipts>/src/cli.ts <command>` is the engine, and an alias `receipts="bun <receipts>/src/cli.ts"` makes the skill commands work verbatim.
6. ask user: (only if the engine is installed) "Paste your OPENAI_API_KEY into `<receipts>/.env` yourself (copy `.env.example`). I will not read or print it." If your brain lives somewhere other than the default, set `GBRAIN_HOME` (an absolute path) in your shell or in `<receipts>/.env`; Receipts passes it to every gbrain call. Raw `gbrain` run inside `<receipts>` ignores a `GBRAIN_HOME` that `<receipts>/.env` assigns and falls back to the default brain, so run raw gbrain from another folder with `GBRAIN_HOME` exported.
7. agent: If the engine is installed, run `receipts doctor`; it checks the key is present (never printed), the model, gbrain and yt-dlp. yt-dlp is only needed for YouTube captions (`brew install yt-dlp` or `pipx install yt-dlp`).
8. agent: If the engine is installed, run `receipts demo --offline`. It loads the curated seed predictions (each with a linked source), syncs them to GBrain person pages, labels drift and writes the site to `out/site`. It uses recorded model fixtures, so it makes no API calls.
9. show user: "Ready. Next: ingest an episode (receipts-ingest), grade what is due (receipts-grade), see how a story drifted (receipts-drift), or ask 'how much should I trust <Name> on <topic>?' (receipts-ask)."
