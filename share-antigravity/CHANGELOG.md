# Changelog

All notable changes to the `ef-share` plugin for Antigravity are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-23

### Added
- **Publish an Antigravity session to ElasticFlow Share**, from the Antigravity
  app, the `agy` CLI and the IDE alike: the `share` skill (`/share`, or just
  ask) and the bundled Share MCP server.
- The session is found by its own id (`ANTIGRAVITY_CONVERSATION_ID`) — never by
  "the newest file" — and its transcript is uploaded as Antigravity wrote it;
  what is published is chosen on the server.
- Redaction candidates are shown grouped by finding; chapters are authored from
  the turn list the server returns.
