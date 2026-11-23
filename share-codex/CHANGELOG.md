# Changelog

All notable changes to the `ef-share` plugin for Codex are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
