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
5. Classify Automations: invoke the `classify-automations` skill with the SNAPSHOT path `$SNAP`. It returns the `automations` JSON object. Pass it **verbatim** — do NOT post-process it with a script or by hand. Never change `classified_by`, `signature`, `kind_id`, or `record_ref`: the server rejects an out-of-enum `classified_by` and any unknown `record_ref`. The skill is the only thing that authors `title`/`why`. (Automations is optional — if it's invalid the server now drops just that panel instead of failing the publish — but don't corrupt it.)
6. Author Chapters: invoke the `author-chapters` skill with the same `$SNAP`. It returns `{ language, chapters }` — English titles (navigation/catalogue layer), session-language hints (content layer). Keep it verbatim (omit the `chapters` param entirely if the skill returned no chapters).
7. Hidden (publishing) records: run the deterministic extractor on the SNAPSHOT to mark this plugin's own publishing flow so it's hidden from readers:
   ```
   node "$CLAUDE_PLUGIN_ROOT/dist/bin/extract-hidden-records.js" "$SNAP"
   ```
   (If `dist` is absent, run `npx tsx "$CLAUDE_PLUGIN_ROOT/bin/extract-hidden-records.ts" "$SNAP"`.) It prints `{ hidden_records }` — keep the array verbatim (it's `[]` when there's nothing to hide, e.g. the very first publish).
7.5. Skill provenance: run the deterministic extractor on the SNAPSHOT to collect publisher attribution for any third-party skills invoked during the session:
   ```
   node "$CLAUDE_PLUGIN_ROOT/dist/bin/extract-skills.js" "$SNAP"
   ```
   (If `dist` is absent, run `npx tsx "$CLAUDE_PLUGIN_ROOT/bin/extract-skills.ts" "$SNAP"`.) It prints `{ skill_contract_version, runtime, skills[] }`. Pass the entire object verbatim as the top-level `skills` argument to `share_publish`. If the script fails or `skills` is empty, omit `skills` entirely — this enrichment is best-effort and never causes a publish failure.
8. Call `mcp__share__share_publish({ stagingId, visibility, title, summary, tags, tos, redactions, automations, chapters, language, hidden_records, skills })` (omit `language` if the skill did not return one; pass `hidden_records` as returned — `[]` is fine; omit `skills` entirely if step 7.5 produced no skills). Receive `{ jobId }`.
9. Poll `mcp__share__share_status({ jobId })` every 2s until `state === "done"` or `"failed"` (max 30). Report "Published: <url> — visibility: <chosen>" or the error.
   - If the terminal status carries `redactionWarnings`, the publish still succeeded but the server detected secret(s) that were NOT redacted. Show the user `redactionWarnings` (kind + preview + location) and `redactionRemediation`: re-run `/share` for this same session with those spans added to `redactions` — it scrubs the leak in place under the same URL.
   - If the terminal status carries `enrichmentWarnings`, the publish still succeeded but an optional panel (e.g. automations) was dropped server-side. Report which and why; do NOT retry for it (the rest of the session published fine).
   - If `state === "failed"`: read the error, then retry on a fresh `share_begin` + re-upload (step 2-3), **preserving every field except the one the error names** — e.g. only drop or repair `automations` when the error is about automations. NEVER drop `hidden_records` or `redactions` on a retry: they are correctness/privacy fields, not optional enrichments. (`hidden_records` is also detected server-side now, so the publishing flow is hidden even if you ever omit it — but still always send it.)

Notes:
- Works for any session size — the transcript is uploaded directly from disk, not through the model.
- The ticket is single-use and short-lived; if the upload fails with an expired/used ticket, re-run step 2 (`share_begin`) for a fresh one.
- One authorization only (the `share` MCP OAuth); the upload uses the ticket, not your token.
