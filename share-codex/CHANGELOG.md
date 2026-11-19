# Changelog

All notable changes to the `ef-share` plugin for Codex are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
