# Changelog

All notable changes to the `ef-share` plugin for Codex are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-11-24

### Added
- **Active publisher handle announcement.** The `share` skill now reads
  `publisher` from `share_begin` and explicitly states which `@handle` (and
  display name) will own the published session before uploading.

### Fixed
- **`refsInHtml()` ignores `<script type="application/json">` data blocks.**
  Inline JSON payloads inside HTML results are no longer scanned as asset
  references, preventing unrelated local paths embedded in JSON strings from
  being pulled into published result bundles.

## [0.3.0] - 2026-11-23

### Added
- **Publish a page the session made, as a result a reader can run.** After the
  session is uploaded, Codex lists the HTML pages the session wrote that are
  still files in its folder — each with exactly the files it would publish, by
  name: the page and the local files it loads from its own folder, never the
  folder around it — and asks. A result is published only on your yes, given
  after you have seen that list; publishing the session again without it takes
  it down. A page that was not listed (one a script made, one outside the
  session's folder) is listed when you name it.
- A picture of each published page is taken on your machine, in the installed
  Chrome, Edge, Chromium or Brave, and published with it: it is what a reader
  sees before they press Run. You are told where the picture is before
  anything is public, and a result can be published without one. A browser
  does not start inside Codex's sandbox: the command that sends a result then
  stops before sending and says so, and Codex asks you to approve running it
  outside the sandbox — or you publish without a picture.
- What a result may hold is checked on your machine by the server's own rules
  (file types, names, sizes) before anything is sent, and each file is sent
  only while it still holds what was listed — a file changed in between stops
  the upload. Secrets found in a result's files are reported, not removed: a
  result is published byte for byte.

### Changed
- Your yes is a yes to the list you were shown: every list has an id, a
  result keeps its number however often the list is made again, and
  `send-results` sends nothing when the list is no longer the one you
  answered — after a page was added or a file changed.
- The pages are named by the server, from the session's record — the plugin
  still does not read the conversation. A name is used only when it is a file
  inside the folder the session ran in; anything else is counted and
  not opened.
- Publishing a result sends the session's record a second time, together with
  the chosen files, under a fresh ticket (`send-results`); the first upload is
  left unpublished and is removed by the server.
- `clean` also removes the list of results and the pictures kept beside the
  snapshot.

## [0.2.1] - 2026-11-23

### Fixed
- **The tool catalogue and the skills listing stay on your machine wherever
  Codex records them.** 0.2.0 said they did and took them out of Codex's
  messages to the model, but Codex keeps a second copy in its record of its own
  state, and that copy was uploaded. The server neither kept nor showed it.
  Found by an independent review the day 0.2.0 was released; measured on 25
  real sessions: 0.2.0 uploaded every one of 578 tool descriptions and 25
  skills listings, 0.2.1 uploads none of them from Codex's own records.

### Changed
- The README says what else of Codex's bookkeeping is in the upload (its record
  of your settings, the commands you have approved among them) and that the
  agent's reasoning summaries are published where Codex recorded one.

## [0.2.0] - 2026-11-23

### Changed
- **The session's record is uploaded as Codex wrote it** — no longer a copy cut
  down to the conversation on your machine. Only three things stay behind:
  Codex's own instructions to the model (base instructions, developer messages,
  the tool catalogue), your Codex account ids and your usage limits. What is
  published is chosen on the server: the conversation, the skills loaded, the
  model and token counts. The rest of the upload (the model-facing copy of each
  step, the copy of `AGENTS.md` Codex injects, encrypted reasoning) is read past
  there and not kept. The upload is larger for it: on the sessions measured, 4 to
  60 times the 0.1.0 upload (about five sixths of the session's file).
- The upload tickets of a session's earlier publishes are masked on the server,
  not in the plugin.
- `prepare` reports `records` and `bytes` of the snapshot (was `records_in` /
  `records_out` / `bytes_in` / `bytes_out` / `history_mode`).
- The skill names a session's address as the server writes it now —
  `/chatgpt/<title>-<id>`, a private session's without its title — and says that
  the title is what the link reads as. Chapter titles are written in the
  language of the session, no longer always in English.

### Added
- An upload the server finds too large says so (`HTTP 413`).

## [0.1.0] - 2026-11-19

### Added
- **Publish a Codex session to ElasticFlow Share**, from Codex CLI and the Codex
  desktop app alike: the `share` skill (`$share`, or just ask) and the bundled
  Share MCP server.
- The session is found by its own id (`CODEX_THREAD_ID`) — never by "the newest
  file" — and a slimmed snapshot is uploaded: the thread items, the turn model
  and token usage. Codex's own instructions, the copy of `AGENTS.md` it injects,
  account ids and usage limits are left out of the upload.
- Redaction candidates are shown grouped by finding; chapters are authored from
  the turn list the server returns; skill and plugin origins are attributed from
  `SKILL.md` frontmatter and Codex's marketplace registry.
