---
name: share
description: Publish the current Codex session to ElasticFlow Share and return its link. Use when the user asks to share or publish this session, conversation or thread, wants a share link for it, or invokes $share.
metadata:
  publisher: elasticflowapp
  homepage: https://elasticflow.app/share/connect
---

# Publish this session to ElasticFlow Share

ElasticFlow Share turns this session into a readable page: the conversation, the
commands and tools it ran, the skills and MCP servers it used. This skill publishes
**the session you are running in** — never another one.

`SCRIPT` below is `scripts/ef-share.mjs` in the directory of this `SKILL.md`. Run it
with `node` (18 or newer). If `node` is missing, say so and stop.

The `share_*` tools are the tools of the `share` MCP server this plugin bundles.

## Steps

1. **Snapshot this session.**
   ```
   node "SCRIPT" prepare
   ```
   It finds this session by `CODEX_THREAD_ID`, writes a snapshot of it to a
   private temporary folder and prints `{ snapshot, thread_id, … }`. The snapshot
   is the session's record as Codex wrote it — the messages, the tool calls and
   everything they printed, the model and token counts, and Codex's bookkeeping
   around them, the text of this project's `AGENTS.md` among it — except Codex's
   own instructions to the model (its base instructions, developer messages,
   tool catalogue and skills listing), your Codex account ids and your usage
   limits: those are taken out before the snapshot is written and never leave
   this machine. What is published is chosen on the server; the rest of the
   upload is not kept.
   - If it exits with an error, report its message and stop. Do not look for a
     session file or a session id yourself and do not add options to make it
     pass: publishing the wrong session is worse than not publishing.

2. **Begin.** Call `share_begin` with `{}`. It returns `{ stagingId, uploadUrl, ticket }`.
   - If the `share` server is not signed in (the tool is missing, or the call is
     refused as unauthorized), tell the user to connect it — `codex mcp login share`
     in a terminal, or **Connect** on the ElasticFlow Share plugin in the app — and
     stop until they have.

3. **Upload the snapshot.**
   ```
   node "SCRIPT" upload --snapshot "<snapshot>" --url "<uploadUrl>" --ticket "<ticket>"
   ```
   This is the one command that needs network access: if the sandbox blocks it, ask
   for approval for this command. The script refuses any address that is not
   ElasticFlow Share and does not follow redirects. It prints
   `{ response_file, runtime, suggestedTitle, metadata, redaction_groups, chapterCandidates }`.
   - A failed upload ends the publish: report the error and stop. An expired or
     used ticket means going back to step 2 for a fresh one. If the script says
     the server did not recognise a Codex session, stop — do not publish.
   - The snapshot is now in the server's staging area, as it was written. What
     the user chooses to redact next is removed there before the session is
     stored or shown to anyone.

4. **Draft and ask.** Write a `title` (at most 80 characters; `suggestedTitle` is a
   start), a `summary` (at most 300), 3–5 lowercase hyphenated `tags`, and 3–7
   `tos` bullets that complete "this session shows…".
   The title is also what the link will read as: on a public or unlisted session
   its words — a-z and 0-9, at most 60 characters, cut at a word — stand in the
   address before the id. So name the work in specific words and put the ones
   that matter first, as a phrase a person would say. The address is no reason
   to change the title's language: Cyrillic is written there in Latin letters,
   and a title in a script the server has no rule for gives an address of the
   tool and the id alone, which works the same.
   Then ask the user, in one message:
   - **visibility** — `public`, `unlisted` or `private`;
   - **what to redact** — show `redaction_groups` (each has a number, a kind, a
     preview and a count; `secret` ones first) and ask which to remove.
   Skip a question the user has already answered in their request, and skip the
   redaction question when there are no groups. The visibility is the user's
   choice, never yours: if they have not stated it and you cannot ask (a
   non-interactive run), stop and say that the visibility is needed.
   Turn the answer into the redaction list:
   ```
   node "SCRIPT" redactions --response "<response_file>" --select <selection>
   ```
   `<selection>` is `none`, or a comma-separated list of any of: `all`, `secrets`,
   group numbers, kinds — for example `secrets,email` or `1,3`. It prints
   `{ redactions }` — pass that array on unchanged. If the script refuses the
   selection, correct it; never publish with fewer redactions than the user asked
   for. Group numbers belong to this upload only: after another upload, show the
   groups again instead of reusing numbers.

5. **Chapters.** `chapterCandidates.turns` lists every user turn with its
   `start_record_ref`, `ts`, `gap_minutes_before` and `preview`. Group the turns,
   in order, into chapters — coherent phases of the work:
   - 3–12 chapters for a long session, never more than 16; a session with fewer
     than about ten turns is fine as one or two;
   - start a new chapter where the topic of the previews changes, or after a gap
     of 30 minutes or more;
   - each chapter is `{ start_record_ref, title, hint }`: `start_record_ref` copied
     exactly from the chapter's first turn (the first chapter uses the first turn;
     refs stay in list order, none repeated); `title` in the language the user
     writes in, at most 120 characters, naming what happened ("Tracing the failing
     upload", not "Discussion") — its words stand in the chapter page's address
     too (`…/ch-2-tracing-the-failing-upload`), so put the ones that matter first;
     `hint` one line, at most 200 characters, in the same language.
   Also note that language as a tag such as `en` or `ru` (`language`). Leave it out
   if you cannot tell. Never invent a `start_record_ref`: the server rejects a
   chapter list with an unknown one and falls back to a plain time split.
   If there are no turns, leave `chapters` out.

6. **Where the skills and plugins came from** (best effort).
   ```
   node "SCRIPT" provenance --snapshot "<snapshot>"
   ```
   It prints `{ skills, plugins }`. Pass each one that is not `null` as it is; leave
   out the ones that are `null`. If the command fails, publish without them.

7. **Publish.** Call `share_publish` with
   `{ stagingId, visibility, title, summary, tags, tos, redactions, chapters, language, skills, plugins }`
   (without the fields you were told to leave out). It returns `{ jobId }`.

8. **Wait and report.** Call `share_status` with `{ jobId }` every couple of seconds
   until `state` is `done` or `failed` (at most 30 times).
   - `done`: `url` is a path — the tool, then the title's words and the id
     (`/chatgpt/fixing-the-upload-digest-1a2b3c4d`; a private session's has no
     title in it: `/chatgpt/1a2b3c4d`). The page's address is `uploadUrl` with its
     `/api/share/upload` ending replaced by that `url`, as it came. Finish with
     exactly one line:
     `Published: <address> — visibility: <visibility>`
   - `redactionWarnings` in the answer: the session is published, but these secrets
     were not removed. Show them and offer to remove them: that is the whole flow
     again from step 1, with `secrets` (and whatever else the user wants) selected
     in step 4 — it stays the same session under the same id. Its address is
     written from the title and the visibility of the latest publish, and a link
     reported before redirects to it.
   - `enrichmentWarnings`: the session is published without the named panel. Say
     which and why; do not retry for it.
   - `failed`: report the error. To retry, start again from step 2 with the same
     snapshot, and keep every field except the one the error names. Never drop
     `redactions` on a retry.

9. **Clean up.** When the publish is over — published, failed for good, or given
   up — remove the snapshot and the stored upload answer:
   ```
   node "SCRIPT" clean --snapshot "<snapshot>"
   ```

## Notes

- Publishing the same session again after more work updates the same page.
- The messages of this publishing flow are hidden from the published page; the work
  before and after it is not.
- The threads of spawned sub-agents are not published (the spawn shows as a tool
  call). Images attached to prompts may not appear on the page.
- Anything a command printed is part of the session. A file the agent read with
  a command — `AGENTS.md` included — is in its output and is published unless
  redacted.
