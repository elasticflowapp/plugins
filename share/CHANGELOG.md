# Changelog

All notable changes to the `ef-share` plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/elasticflowapp/plugins/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.6.0
[0.5.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.5.0
