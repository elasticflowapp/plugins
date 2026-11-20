# Changelog

All notable changes to the `ef-share` plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.0] - 2026-11-20

Brings the plugin up to date with Claude Code 2.1.281–2.1.325, in the terminal
and in the desktop app. Every shape named here was measured on real sessions of
those versions on 2026-11-16.

### Added
- **Sub-agents are published.** Claude Code keeps each sub-agent's transcript in
  its own file (`<session>/subagents/agent-<id>.jsonl`, plus the agents a
  Workflow run spawned under `subagents/workflows/<run>/`); the main transcript
  holds none of their records any more. `/share` uploaded only the main file, so
  a published session showed none of the delegated work. They are now collected,
  minimised and uploaded with the session, each with its meta file (type,
  description, the spawning call's id).
- **`ef-share-session`** — the plugin's own tool, on the Bash tool's PATH (a
  plugin's `bin/`), so `/share` no longer depends on `$CLAUDE_PLUGIN_ROOT`, which
  the Bash tool does not have. `prepare` does everything deterministic from one
  reading of the transcript; `show` prints the candidates to author from;
  `upload` sends one ticketed request. Each option is given once — `--result`
  alone may be repeated, once per page; an unknown option, or any other given
  twice, is refused. Exit code 2 means the caller can fix it, 1 that
  the request failed.
- **Results, on an explicit yes.** `prepare` lists the HTML pages the session
  wrote, edited or sent to the person — and any page the person names with
  `--result`, first — each with exactly the local files it loads, by name.
  `/share` must ask whether to publish them as well as the session; an upload
  that carries results is never auto-approved. A file is listed only if the
  server will take it: inside the page's own folder, not hidden, a publishable
  type, a plain name; everything else is shown as not published, with the
  reason.
- **A picture of each published result.** At upload the plugin opens the page
  once in the installed Chrome, Edge, Chromium or Brave (headless, a throwaway
  profile, software WebGL) and photographs it. The page is served from a local
  address with only the result's own files and the policy the site applies, and
  is held in a sandboxed frame it cannot navigate out of — as on the session
  page. The picture is the page as it looks once it has loaded and four
  seconds of its timers have run, in a 1024 px wide window, in the light colour
  scheme; an animation is caught near its start, and blank rows at the bottom
  of the window are cut. It is published with the result and shown at the top of the
  session, and the upload names the picture file so it can be looked at before
  anything is public. A page still loading after 8 s is photographed as it
  stands. No picture is sent — and the upload says why — when there is no such
  browser, the page has drawn nothing, the browser is not done within 20 s
  (60 s for all the pictures of one upload), or the picture does not fit the
  upload. `EF_SHARE_BROWSER` names a browser; `--pictures none` or
  `EF_SHARE_PREVIEW=off` publishes without pictures.
- **Staged enrichment.** Automations, chapters, hidden records, skill and plugin
  provenance and Workflow runs travel with the upload. The publishing agent
  writes only titles into two small files; anchors are merged mechanically and a
  mistake in a title file is named before anything is sent, instead of a silent
  server-side fallback after it. One gap remains on the server: when the same
  session is published a second time, chapters after the earlier publish can
  still be placed late or replaced by generated ones.
- Workflow runs (name, status, phases, agent count) are read from the session's
  run records.

### Changed
- **The transcript is minimised before it leaves the machine.** Current
  transcripts also record the API requests, the system prompt, the instruction
  files Claude Code loaded (CLAUDE.md, memory), the account email and org ids,
  the remote-control URL — 31% of the bytes over 70 measured sessions. Only an
  allowlist is uploaded, at three levels: the record kind (type, `system`
  subtype, attachment type), the fields of a kept record, and — in a hook
  firing — only the fields of the firing that are read. The rest stays local,
  and the prepare output names every kind and field it left, for the main
  transcript and for the sub-agent transcripts. Structured tool results (an Edit's
  holds the whole original file) and thinking signatures are stripped. What a
  hook injected INTO the session is part of the session and is published;
  prepare counts those injections so `/share` can say so.
- **Two things the record kinds alone did not keep on the machine.** The desktop
  app (Claude Code 2.1.309 and later) writes, when the working directory
  changes, a message of its own that carries the whole project `CLAUDE.md`: an
  instruction block inside a message Claude Code wrote is cut, in the main and
  the sub-agent transcripts. And the desktop app's folder layout holds the
  organisation id and the account id, so they stood in every record's working
  directory: the organisation id, the account id and the account e-mail are
  read from the account record of the Claude Code that runs `/share`, from the
  session's records that stay behind and from the folder layouts that name
  them (the desktop app's workspaces and session folders, synced skills, with
  any separator between their parts), and replaced by a placeholder where they
  stand in what is uploaded — the conversation included. So a terminal
  session, which records nothing about the account, has the address replaced
  in a command's output too. What is looked for is the identifier itself: an
  id written without its hyphens, an address spelt out, or the e-mail of any
  other account — one no longer used, or the one another Claude app on the
  machine is signed in to — is conversation text like any other.
  The ids that link records are never edited. `prepare` counts the cuts and
  the replacements; it never prints an identifier.
- A record of the main transcript that holds a Unicode line separator (U+2028,
  U+2029) is written with it escaped. The server reads that transcript line by
  line and took such a record for two halves: the session could not be
  published at all (5 of 213 measured sessions, with 0.11.0 as well).
- **Plugins are named before they are sent.** Only the plugins the session
  refers to are uploaded (the ones it had enabled — their skills and tools are
  listed in the transcript), `prepare` names them, and a source address goes
  out as an http(s) address without user name, password, query string or
  fragment, or not at all.
- The `PreToolUse` hook approves the plugin's own `prepare` / `show` / `upload`
  (and the two authored title files) and hands `prepare` this session's
  transcript path from the hook input, so resolution no longer depends on an
  exported env file or on a marker in context — it works when the model starts
  `/share` through the Skill tool and on desktop builds before 2.1.304. A
  command is recognised by tokenising it the way the shell does and matching the
  words against the tool's own argument grammar: anything the shell would
  interpret (a quote trick, a substitution, a chained command) is not approved.
  Not approved either: an upload that carries results, `prepare --out`, a page
  named with `prepare --result`, another session's transcript, a `--transcript`
  that is not an absolute path, an upload over plain http or to a loopback
  address. On anything it does not expect the hook gives no opinion.
- **A prepared directory is checked, not taken on its name.** `show`, `upload`
  and the approval of the two title files accept only a directory `prepare`
  made: a real directory of the person's own, closed to other users, in the
  tool's work directory under the name `prepare` gives (the tool also takes the
  `--out` directory its own manifest records). At upload every sub-agent file
  must be inside it and every result file must still be the file that was
  listed. A directory that merely holds files with the right names — one that
  came with a cloned repository, say — is refused with exit code 2 and the
  reason, before anything is read or sent; so is a file or a folder in it that
  is a link to another one.
- `upload` never follows a redirect, and refuses before sending a session the
  server would refuse once unpacked (256 MB main transcript, 96 MB per
  sub-agent), so the ticket is not spent on it.
- **`upload` prints what is decided on first.** Its output starts with `ok`,
  `status`, `staged`, `notes` and `sent` and stays inside what Claude Code shows
  of a command; the redaction candidates of severity `secret` follow, one per
  line, and the complete list and the server's whole reply are saved in the
  prepared directory. (A real session's reply lists 160–350 candidates, about
  90 KB — more than is shown.) A request that got no answer says so and why.
- **The 0.7–0.11 `curl` upload is no longer approved without a prompt.** It
  sends a transcript as it is on disk, not minimised, and names the file itself
  — approving it meant approving the upload of any session's raw transcript.
  The current `/share` never issues it; typed by hand it asks like any command.
- Publishing records are recognised in the shapes current Claude Code writes:
  the command expanded as a skill (an `isMeta` record, no slash), the model
  calling the `Skill` tool, the plugin's own tool in Bash. A background agent
  reporting back mid-publish no longer ends the hidden span, and a skill merely
  named like `share` no longer opens one.
- Chapter candidates are the turns the person started: background-agent
  notifications, other agents' messages and scheduled prompts are left out, and
  the desktop app's `<system-reminder>` block is not taken for the prompt. Left
  out too, because the server gives them no turn of their own and a chapter
  anchored on one made it drop every authored chapter: the turns of a publish
  itself (`/share`, the answers to its questions), a command the CLI ran itself
  (`/model`, `/effort`, `/autocompact`) and a command the model answered
  without an expansion (`/goal`). A skill or plugin command is offered when
  its expansion follows it directly.
- `/share` reports the published session as a full address, built from the
  upload address and the path the server returns, and stops at `prepare` when
  the session is too large to upload instead of after the questions.
- The size `prepare` reports is the request `upload` sends, part by part. When
  it would not fit the endpoint, the main transcript goes compressed; then
  sub-agent tool output (never the main transcript) is cut in steps and the
  prepare output says so. `upload` measures the request, chosen results
  included, and refuses one that is over the limit before sending anything.
- The prepared directory is private to the user (0700) and is the tool's own:
  `prepare` writes only into a new directory, an empty one, or one it made, and
  removes the copies it left more than a day ago.
- The published tree carries `dist/package.json` (`"type": "module"`) and no
  longer ships the five `extract-*` programs nothing calls, nor the sign-in
  helpers of the pre-0.7 client (`credentials`, `http`, `open-url`).

### Deploying
- The server side of this change goes first. The plugin lists a result file
  only if the server will take it, by the server's rules as of this change (a
  file name stored decomposed, as macOS writes accented letters, is one of
  them); an older server answers such an upload with `400 bad_results`.

### Fixed
- `version-bump.test.ts` asserted the real manifests still said 0.5.0, and
  `schema.test.ts` predated the `PreToolUse` hook — six tests red since 0.7.0.

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

[Unreleased]: https://github.com/elasticflowapp/plugins/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.12.0
[0.11.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.11.0
[0.10.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.10.0
[0.9.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.9.0
[0.8.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.8.0
[0.7.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.7.0
[0.6.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.6.0
[0.5.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.5.0
