---
name: author-chapters
description: Use during /share publishing to produce the ElasticFlow `chapters` payload — reads the turn candidates `ef-share-session prepare` extracted, then groups the session's turns into 3-12 semantically titled chapters and writes them to the prepared directory.
---

# Author session Chapters

Chapters are the session's reading narrative on ElasticFlow Share: the ToC
accordion, the collapsed-middle cards, and a page per chapter. The
deterministic step already listed every turn the PERSON started, with its REAL
record uuid. Your job is to GROUP those turns into chapters and TITLE them.
Never invent a uuid — an anchor that is not in the list is refused.

A chapter's title is also read outside the session's own page. On a public or
unlisted session it is written into that chapter page's address —
`/claude-code/<session title>-<id>/ch-2-debugging-access-denied` — and the
chapter page's own title starts
`Chapter 2: Debugging access_denied · <session title>`. That title is what a
public session's chapter page offers a search engine. (A private session's
addresses carry no title — `/claude-code/<id>/ch-2` — and neither do the
chapter addresses of a session whose own title leaves no words for one.)

You are given `dir`, the directory `ef-share-session prepare` printed.

## Steps

1. Print the candidates:
   ```
   ef-share-session show chapters --dir "<dir>"
   ```
   (If the shell answers `command not found`: `node "${CLAUDE_PLUGIN_ROOT}/bin/ef-share-session" show chapters --dir "<dir>"`.)
   It prints `{ write_to, format, turns[] }`; each turn has `start_record_ref`, `ts`,
   `gap_minutes_before`, `slash`, `preview`. Background agents reporting back, other
   agents' messages, scheduled prompts and the runtime's own "[Request interrupted…]"
   marker are already left out — every listed turn is something the person typed.
   The turns of a publish (`/share` and the answers to its questions) are not listed
   either: readers are not shown them, so there is no chapter for publishing.

2. Read the `turns` in order and group them into **3-12 chapters** (never more than 16;
   a session under ~10 turns is fine as 1-2 chapters). While reading, determine the
   session's predominant human language from the `preview`s (the language the USER
   writes in, ignoring code/paths/tool noise) — a lowercase primary tag (`ru`, `en`,
   `fi`, …). A chapter is a coherent phase of work. Boundary signals, strongest first:
   - the topic of the `preview`s shifts (new goal, new artifact, new problem);
   - `gap_minutes_before` ≥ 30 (the author walked away);
   - the dominant `slash` workflow changes (e.g. brainstorming → implementation → review).
   Do NOT start a new chapter on every slash command — the same command often repeats
   within one phase.

3. For each chapter:
   - `start_record_ref`: the `start_record_ref` of its FIRST turn, copied verbatim. The
     first chapter MUST use the first listed turn. Refs follow the list order, one
     chapter per ref.
   - `title`: ≤120 chars, in the SESSION language (the one you determined in
     step 2), names what HAPPENED in that phase ("Designing the hooks
     visualization", not "Discussion"). The address takes the title's words in
     a-z and 0-9, at most 60 characters, cut at a word — so name the work in
     specific words (the thing built, fixed or decided), put the words that
     matter first and keep the main ones within about the first 60 characters
     — about the first 50 of a Cyrillic title, where one letter can take two to
     four Latin ones. Write it as a phrase a person would say, not as a list of
     keywords. The address is no reason to write the title in another language:
     the server writes Cyrillic in Latin letters («Настройка хуков» becomes
     `ch-2-nastroyka-khukov`), and a title in a script it has no rule for gives
     an address without words (`ch-2`), which works the same.
   - `hint` (REQUIRED): one line (≤200 chars) summarizing what happens inside the
     chapter, in the SESSION language — the reader-facing summary of collapsed content.

4. Write the result with the Write tool to the `write_to` path from step 1
   (`<dir>/authored/chapters.json`), e.g. for an English-language session:
   ```json
   {
     "language": "en",
     "chapters": [
       { "start_record_ref": "<uuid>", "title": "Setting up the share flow", "hint": "OAuth + staging upload" },
       { "start_record_ref": "<uuid>", "title": "Debugging access_denied", "hint": "Traced the consent redirect; fixed the Enter-key authorize path" }
     ]
   }
   ```
   The upload step checks this file against the candidates and names any mistake
   before anything is sent: a ref that is not in the list, a chapter without its
   hint, a key other than `start_record_ref` / `title` / `hint`.

## Rules
- Only uuids that appear in `turns[]`; never edit, merge, or invent refs.
- Keep refs in list order; one chapter per ref; no duplicate refs.
- Titles describe the work truthfully — no marketing language.
- Every chapter MUST carry a hint, and nothing but `start_record_ref`, `title` and `hint`.
- If you cannot determine the language confidently, leave `language` out rather than
  guessing — still write each title and hint in the language the user appears to use,
  and in English when nothing shows one.
- If `turns` is empty, write nothing: the session is published without client chapters.
