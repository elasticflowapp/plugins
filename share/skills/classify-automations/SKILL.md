---
name: classify-automations
description: Use during /share publishing to produce the ElasticFlow `automations` payload — runs the deterministic extractor, then enriches each kind with a plain-language title and why.
---

# Classify session Automations

The deterministic helper does the extraction (real record uuids, native events, floor
category). Your job is to ENRICH meaning. Never invent uuids or change the floor
`category` unless it is clearly wrong.

## Steps

1. Run the extractor on the transcript:
   ```
   node "$CLAUDE_PLUGIN_ROOT/dist/bin/extract-automations.js" "<transcript_path>"
   ```
   (If `dist` is absent, run `npx tsx "$CLAUDE_PLUGIN_ROOT/bin/extract-automations.ts" "<transcript_path>"`.)
   It prints a JSON object: `{ automation_contract_version, runtime, kinds[], occurrences[] }`.

2. For each entry in `kinds`, improve `title` (short, plain language) and write a one-
   sentence `why` (why this ran, for a non-technical reader). You MAY correct an obviously
   wrong `category` (must stay in safety|context|capture|sync|lifecycle|other) and raise
   `confidence` to medium/high when sure. Leave `signature`, `kind_id`, and all
   `occurrences` EXACTLY as the extractor produced them.

3. Return the whole object (with your enriched `kinds`) as the `automations` value for
   `share_publish`. Output ONLY the JSON.

## Rules
- Write every `title` and `why` in **English** (the catalogue language), regardless of the session's conversation language.
- Do not add, remove, or re-anchor occurrences. Do not edit any `record_ref`.
- Keep it truthful; if unsure, keep the floor title and `confidence:"low"`.
