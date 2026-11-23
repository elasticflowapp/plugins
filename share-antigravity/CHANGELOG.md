# Changelog

All notable changes to the `ef-share` plugin for Antigravity are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-11-23

### Changed
- **Where to sign in.** The README and the skill said Antigravity asks for the
  sign-in by itself the first time, or offers it under `/plugin`. It does
  neither in `agy` 1.5.15: the Share server is signed in from `/mcp` — the
  `ef-share_share` server, **Authenticate** — and the CLI then asks for an
  authorization code to paste. Both texts say so now, and the skill tells the
  agent that the code is the person's to paste and never to ask for.

## [0.2.0] - 2026-11-23

### Added
- **Publish a page the session made, as a result a reader can run.** After the
  session is uploaded, the agent lists the HTML pages the session wrote that are
  still files in its folder — each with exactly the files it would publish, by
  name: the page and the local files it loads from its own folder, never the
  folder around it — and asks. A result is published only on your yes, given
  after you have seen that list; publishing the session again without it takes
  it down. A page that was not listed (one a script made, one outside the
  session's folder) is listed when you name it.
- A picture of each published page is taken on your machine, in the installed
  Chrome, Edge, Chromium or Brave, and published with it: it is what a reader
  sees before they press Run. You are told where the picture is before
  anything is public, and a result can be published without one.
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
  inside the folder the session ran in (the folder the publish was run from); anything else is counted and
  not opened.
- Publishing a result sends the session's record a second time, together with
  the chosen files, under a fresh ticket (`send-results`); the first upload is
  left unpublished and is removed by the server.
- `clean` also removes the list of results and the pictures kept beside the
  snapshot.

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
