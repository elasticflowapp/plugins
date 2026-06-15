---
name: author-chapters
description: Use during /share publishing to produce the ElasticFlow `chapters` payload — runs the deterministic candidate extractor, then groups the session's turns into 3-12 semantically titled chapters.
---

# Author session Chapters

Chapters are the session's reading narrative on ElasticFlow Share: the ToC
accordion, the collapsed-middle cards, and the `/{id}/ch-{n}` pages. The
deterministic helper lists every human user turn with its REAL record uuid.
Your job is to GROUP those turns into chapters and TITLE them. Never invent
uuids — the server rejects fabricated anchors and falls back to a dumb
time-gap heuristic, losing your semantic structure.

## Steps

1. Run the extractor on the transcript:
   ```
   node "$CLAUDE_PLUGIN_ROOT/dist/bin/extract-chapters.js" "<transcript_path>"
   ```
   (If `dist` is absent, run `npx tsx "$CLAUDE_PLUGIN_ROOT/bin/extract-chapters.ts" "<transcript_path>"`.)
   It prints `{ chapter_contract_version, runtime, total_candidates, turns[] }` where each
   turn has `start_record_ref`, `ts`, `gap_minutes_before`, `slash`, `preview`.

2. Read the `turns` in order and group them into **3-12 chapters** (never more than 16;
   a session under ~10 turns is fine as 1-2 chapters). While reading, determine the
   session's predominant human language from the `preview`s (the language the USER
   writes in, ignoring code/paths/tool noise) — output it as a BCP-47 primary tag
   (`ru`, `en`, `fi`, …). A chapter is a coherent phase of
   work. Boundary signals, strongest first:
   - the topic of the `preview`s shifts (new goal, new artifact, new problem);
   - `gap_minutes_before` ≥ 30 (the author walked away);
   - the dominant `slash` workflow changes (e.g. brainstorming → implementation → publishing).
   Do NOT start a new chapter on every slash command — the same command often repeats
   within one phase.

3. For each chapter emit:
   - `start_record_ref`: the `start_record_ref` of its FIRST turn — copied verbatim from
     the extractor output. The first chapter MUST use the first listed turn. Refs must
     appear in the same order as in `turns` (strictly increasing).
   - `title`: ≤120 chars, plain English (catalogue language, regardless of the session's
     conversation language), names what HAPPENED in that phase ("Designing the hooks
     visualization", not "Discussion"). Titles are English (navigation/catalogue layer);
     hints are session-language (content layer).
   - `hint` (REQUIRED): one line (≤200 chars) summarizing what happens inside the
     chapter, written in the SESSION language detected above — this is the
     reader-facing summary of collapsed content.

4. Output ONLY the JSON object, e.g. (an English-language session):
   ```json
   {
     "language": "en",
     "chapters": [
       { "start_record_ref": "<uuid>", "title": "Setting up the share flow", "hint": "OAuth + staging upload" },
       { "start_record_ref": "<uuid>", "title": "Debugging access_denied", "hint": "Traced the consent redirect; fixed the Enter-key authorize path" }
     ]
   }
   ```
   `chapters` becomes the `chapters` value for `share_publish`; `language` becomes its
   `language` value.

## Rules
- Only uuids that appear in the extractor's `turns[]`; never edit, merge, or invent refs.
- Keep refs in list order; one chapter per ref; no duplicate refs.
- Titles describe the work truthfully — no marketing language.
- Every chapter MUST carry a hint.
- If you cannot determine the language confidently, omit `language` rather than guessing
  — still write each hint in the language the user appears to use; only the top-level
  `language` field is omitted.
- If the extractor returns no turns, skip chapters entirely (call `share_publish` without it).
