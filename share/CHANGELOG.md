# Changelog

All notable changes to the `ef-share` plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/elasticflowapp/plugins/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.5.0
