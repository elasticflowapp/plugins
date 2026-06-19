# Changelog

All notable changes to the `ef-share` plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.0] - 2026-06-19

### Added
- **Skill source provenance from the install lockfile.** At publish,
  `extract-skills` reads the skill-manager lockfile (`skills-lock.json`) and
  attributes each loose skill to its **source repository** — `publisher` = repo,
  `author` = owner, `source` = the GitHub URL — instead of `_unknown` when the
  `SKILL.md` frontmatter declares no author (ADR-0023). Resolution is scope-aware
  (a skill is governed by the nearest lockfile above its on-disk location;
  project and user scopes never cross), anchored on the transcript-recorded cwd,
  and the lockfile wins over frontmatter. Best-effort and non-gating.

## [0.10.0] - 2026-06-19

### Added
- **Plugin source provenance.** At publish, `commands/share.md` runs the new `extract-plugins` extractor to read the local Claude Code plugin registry (`installed_plugins.json` + `known_marketplaces.json` + each marketplace's `.claude-plugin/marketplace.json`) and resolves each installed plugin's real source URL and author name via `extractAllPluginProvenance`. The result is sent as the top-level `plugins` argument to `share_publish`. Best-effort and non-gating — a missing registry or empty payload never fails the publish.
- `publish-ef-share.sh` now ships `dist/bin/extract-plugins.js` alongside the other publish-time extractors.

## [0.9.0] - 2026-06-18

### Added
- **Skill publisher provenance.** At publish, `commands/share.md` runs the `extract-skills` extractor over the session snapshot to capture each standalone skill's declared publisher metadata (`publisher` / `homepage` / `repository` / `author` / `license` / `version` from `SKILL.md` frontmatter, top-level or under `metadata:`) and sends it as the top-level `skills` argument to `share_publish`. The viewer resolves a standalone skill's Publisher from this (else the `unknown` fallback) instead of attributing it to `_unknown` (ADR-0021). Best-effort and non-gating — a missing/empty payload never fails the publish.
- `publish-ef-share.sh` now ships `dist/bin/extract-skills.js` alongside the other publish-time extractors.

## [0.8.0] - 2026-06-18

### Changed

- **Resilient enrichment in `/share`.** The publish flow now defers to the server
  as the source of truth for enrichment and hardens its failure handling:
  - Classified `automations` are passed **verbatim** — `/share` never rewrites the
    `classified_by`, `signature`, `kind_id`, or `record_ref` fields the server
    validates.
  - An invalid or absent `automations` payload no longer fails the publish: the
    server drops just that panel and reports it via `enrichmentWarnings`, which
    `/share` now surfaces to the publisher instead of pointlessly retrying.
  - On a failed publish, a retry preserves every field except the one the error
    names, and **never** drops `hidden_records` or `redactions` — they are
    correctness/privacy fields, not optional enrichments.
- **Server-side publishing-record detection.** `hidden_records` is now also
  detected server-side, so a session's own `/share` flow stays hidden even if the
  client ever omits the array; `/share` still always sends it (ADR-0020).

## [0.7.0] - 2026-06-17

### Added

- **Frictionless publishing.** A `PreToolUse` hook auto-approves ef-share's own
  session-transcript upload, so `/share` publishes without a permission prompt (or
  an auto-mode classifier denial) — installing the plugin authorizes publishing. The
  hook is scoped to the plugin's own ticketed upload to the Share endpoint (host
  allowlist + `X-Upload-Ticket` + `session.jsonl`) and is shell-injection-guarded; it
  stays neutral on every other command (ADR-0019).

## [0.6.0] - 2026-06-17

### Added

- **Publishing-record marking.** `/share` now detects the session's own publishing
  flow (the `/share` command and the steps it triggers) and sends `hidden_records`
  to `share_publish`, so the published session — and its shareable SVG — exclude the
  publishing noise while the full transcript is retained. New `extract-hidden-records`
  extractor.

### Fixed

- The compiled extractor binaries (`extract-chapters`, `extract-automations`, and the
  new `extract-hidden-records`) are now shipped under `dist/bin/`; previously only
  `dist/src/` was packaged, so the extractor scripts were absent from the installed
  plugin.

## [0.5.0] - 2026-06-15

Initial public release of the `ef-share` Claude Code plugin.

### Added

- ElasticFlow Share MCP server connection over HTTP at
  `https://share.elasticflow.app/mcp` (OAuth on first use; overridable for local
  development via the `EF_SHARE_MCP_URL` environment variable).
- `/share` command to publish the current Claude Code session to ElasticFlow
  Share.
- `author-chapters` skill for chapter authoring.
- `classify-automations` skill for automation classification.
- `SessionStart` and `UserPromptSubmit` hooks (compiled hook scripts shipped
  with the plugin).
- Published to the `elasticflowapp/plugins` marketplace; install with
  `claude plugin install ef-share@elasticflowapp`.

[Unreleased]: https://github.com/elasticflowapp/plugins/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.11.0
[0.10.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.10.0
[0.9.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.9.0
[0.8.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.8.0
[0.7.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.7.0
[0.6.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.6.0
[0.5.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.5.0
