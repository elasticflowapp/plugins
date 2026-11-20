---
name: classify-automations
description: Use during /share publishing to produce the ElasticFlow `automations` payload — reads the automation kinds `ef-share-session prepare` extracted, then gives each kind a plain-language title and why and writes them to the prepared directory.
---

# Classify session Automations

The deterministic step already extracted every background action of the session
(hook firings: real record uuids, native events, a floor category) and grouped
them into kinds. Your job is to give each KIND its meaning. You never see or
touch the firings themselves — they are merged mechanically at upload.

You are given `dir`, the directory `ef-share-session prepare` printed.

## Steps

1. Print the kinds:
   ```
   ef-share-session show automations --dir "<dir>"
   ```
   (If the shell answers `command not found`: `node "${CLAUDE_PLUGIN_ROOT}/bin/ef-share-session" show automations --dir "<dir>"`.)
   It prints `{ write_to, format, kinds[] }`; each kind has `kind_id`, `floor_title`,
   `category`, `action_kind`, `trigger_phase`, `native_event`, `source_kind`,
   `source_ref` and `firings` (how many times it ran).

2. For each kind write a `title` (short, plain language, ≤200 chars) and a one-sentence
   `why` (why this ran, for a non-technical reader, ≤400 chars). You MAY correct an
   obviously wrong `category` (it must stay one of
   safety|context|capture|sync|lifecycle|other) and set `confidence` to `medium` or
   `high` when sure. A kind you leave out keeps its floor title.

3. Write the result with the Write tool to the `write_to` path from step 1
   (`<dir>/authored/automations.json`):
   ```json
   {
     "kinds": {
       "k1": { "title": "Loaded the project's working rules", "why": "A plugin adds its guide to the conversation when the session starts.", "confidence": "high" },
       "k2": { "title": "Checked each shell command before it ran", "why": "A safety hook reviews commands for risky operations." }
     }
   }
   ```

## Rules
- Write every `title` and `why` in **English** (the catalogue language), whatever the
  session's conversation language.
- Only `kind_id`s that appear in `kinds[]`, each an object with `title`, `why` and —
  optionally — `category` and `confidence`. No other keys: the upload step refuses an
  unknown kind, a misspelt key, a title that is not text or an out-of-set category,
  and names it before anything is sent.
- Keep it truthful; if unsure, leave the kind out (it keeps the floor title).
