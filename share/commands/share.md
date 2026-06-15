---
description: Publish this session to ElasticFlow Share
---

# /share

Workflow:

1. Resolve THIS session's transcript path (do NOT read any shared/global file):
   a. Use the injected `<EF-SHARE-CURRENT transcript_path="…" … />` marker in context if present.
   b. Else run `printf '%s' "$EF_SHARE_TRANSCRIPT_PATH"` (Bash). If non-empty, use it.
   c. Else ABORT: "Couldn't resolve the current session's transcript — not publishing." Do NOT guess.
   d. SNAPSHOT it — the live transcript keeps growing while you work, and the server
      rejects automation/chapter refs that aren't in the uploaded file:
      `SNAP=$(mktemp /tmp/ef-share-XXXXXX).jsonl && cp "<transcript_path>" "$SNAP"`
      Use `$SNAP` for the upload AND for both extractor skills below.
2. Call `mcp__share__share_begin({})`. On the first call this session, Claude Code prompts for OAuth — wait for approval. Receive `{ stagingId, uploadUrl, ticket }`.
3. Upload the transcript with the Bash tool (the file streams from disk — never paste its contents):
   ```
   curl -sS -X POST "<uploadUrl>" -H "X-Upload-Ticket: <ticket>" -F "session.jsonl=@$SNAP;type=application/jsonl"
   ```
   The response is JSON: `{ suggestedTitle, redactionCandidates, metadata }`.
   - If `curl` is missing or the upload returns a non-2xx status, report the error and stop (do not publish).
4. Draft a title (<=80, may start from `suggestedTitle`), summary (<=300), 3-5 lowercase hyphenated tags, 3-7 "this session shows…" bullets (tos). Show the user `redactionCandidates` and ask which to redact. Ask: public, private, or unlisted?
5. Classify Automations: invoke the `classify-automations` skill with the SNAPSHOT path `$SNAP`. It returns the `automations` JSON object. Keep it verbatim.
6. Author Chapters: invoke the `author-chapters` skill with the same `$SNAP`. It returns `{ language, chapters }` — English titles (navigation/catalogue layer), session-language hints (content layer). Keep it verbatim (omit the `chapters` param entirely if the skill returned no chapters).
7. Call `mcp__share__share_publish({ stagingId, visibility, title, summary, tags, tos, redactions, automations, chapters, language })` (omit `language` if the skill did not return one). Receive `{ jobId }`.
8. Poll `mcp__share__share_status({ jobId })` every 2s until `state === "done"` or `"failed"` (max 30). Report "Published: <url> — visibility: <chosen>" or the error.
   - If the terminal status carries `redactionWarnings`, the publish still succeeded but the server detected secret(s) that were NOT redacted. Show the user `redactionWarnings` (kind + preview + location) and `redactionRemediation`: re-run `/share` for this same session with those spans added to `redactions` — it scrubs the leak in place under the same URL.

Notes:
- Works for any session size — the transcript is uploaded directly from disk, not through the model.
- The ticket is single-use and short-lived; if the upload fails with an expired/used ticket, re-run step 2 (`share_begin`) for a fresh one.
- One authorization only (the `share` MCP OAuth); the upload uses the ticket, not your token.
