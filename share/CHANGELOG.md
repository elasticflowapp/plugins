# Changelog

All notable changes to the `ef-share` plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.13.0] - 2026-11-24

### Added
- **Multi-signal HTML deliverable discovery.** `prepare` now discovers compiled
  and script-generated HTML pages produced in Bash or verified in a browser
  (such as `open`, Playwright, or local script outputs) in addition to pages
  written directly by `Write` / `Edit`. Built deliverables are ranked ahead of
  unexpanded skeleton templates (`template.html` or files with build
  placeholders), and `/share` warns before selecting a template-hinted file.
- **Active publisher handle announcement.** `/share` reads the `publisher`
  object returned by `share_begin` and `/api/share/upload` and tells the user
  which `@handle` (and display name) will own the published session before
  uploading. `client.json` now sends `client_version` so the server can warn
  legacy clients (`< 0.12.0`).

### Fixed
- **`refsInHtml()` ignores `<script type="application/json">` data blocks.**
  Inline JSON payloads (such as Next.js data islands or chart datasets that
  mention markdown or local paths inside string values) are no longer parsed
  as HTML asset references, preventing unrelated workspace files from being
  pulled into published result bundles.

## [0.12.2] - 2026-11-23

The texts follow the session addresses the server now writes (ADR-0030), and
chapter titles are written in the session's language. What `/share` reads,
withholds and uploads is as in 0.12.1.

### Changed
- **`/share` and the chapter skill describe a session's address as the server
  now writes it** (ADR-0030): `/<tool>/<title>-<id>` for a public or unlisted
  session — `/claude-code/fixing-the-upload-digest-1a2b3c4d` —
  `/<tool>/<id>` for a private one, and `…/ch-<n>-<chapter title>` for a
  chapter's page (`…/ch-<n>` under a private session's address). The title's
  words are written in a-z and 0-9, at most 60 characters, cut at a word;
  Cyrillic is written in Latin letters, and a title in a script the server has
  no rule for leaves the address without words. Nothing that builds or reads a
  link changed: it is built as before — the upload address without
  `/api/share/upload`, then the `url` the publish job answers with — and a
  link reported earlier (`/<id>`) redirects to the session's address for
  whoever may open the session. `commands/share.md` shows the `url` in its new
  shape, tells whoever drafts the title that it is what the link will read as
  — specific words, the ones that matter first, in the language the title
  would be in anyway — and no longer says that a session published again keeps
  its URL: it keeps its id, and its address is written from the title and the
  visibility of the latest publish. `author-chapters` says that a chapter's
  title is part of its page's address and of the page title a public session's
  chapter offers a search engine, and how to write one that serves both —
  specific words, the ones that matter first, a phrase and not a list of
  keywords.
- **Chapter titles are written in the session's language.** Until now
  `author-chapters` asked for English whatever language the session was in,
  while the hint followed the session. The skill, and the format
  `ef-share-session show chapters` prints, now ask for the session's language
  in both — the owner's decision of 2026-11-23. The limit stays at 120
  characters. In a chapter's address a Cyrillic title is written in Latin
  letters (`ch-2-nastroyka-khukov`); a title in a script the server has no
  rule for leaves `ch-2`. Automation titles stay English.

## [0.12.1] - 2026-11-22

Closes the notes the 0.12.0 release review left open. The shapes and counts
named here were measured on 2026-11-21 on Claude Code 2.1.271–2.1.326.

### Changed
- **The account of every Claude app on the machine is replaced, not only the
  one that runs `/share`.** The desktop app keeps its own record of the account
  it is signed in to, per session, and that can be another account than the
  terminal's: its address then stood in what a terminal session published — a
  git author line, a tool input. `prepare` now reads all of these records:
  `$CLAUDE_CONFIG_DIR/.claude.json`, `~/.claude.json`, and the desktop app's
  `local-agent-mode-sessions/<account>/<organisation>/local_*/.claude/.claude.json`
  — whose folders name both ids even where a record is gone. Of a record
  exactly three fields are read, `accountUuid`, `organizationUuid` and
  `emailAddress`, each taken only in the shape of one; 0.12.0 also took any
  other key of the record that ended like one of them. Of one account's desktop
  sessions the newest 200 records are read. `prepare` prints how many records it read
  and how many were there and could not be used (not a regular file, over
  64 MB, not JSON) — with a warning, since an address only such a record names
  is not replaced — and never a value. The 0.12.0 review measured the desktop
  account's address in the uploads of 15 terminal sessions, 348 times; on the
  181 sessions scanned for this version, 0.12.0 left it 242 times in the files
  of 12, and this version in none.
- **Of a hook firing and of a message, only what is read is published.** A
  hook attachment goes out with its fields only when its type has been measured
  (`hook_success`, `hook_additional_context`, `hook_non_blocking_error`); any
  other `hook_*` type keeps the firing's name, event and tool-use id — each
  only where it is a short string — and nothing it printed, ran or injected:
  0.12.0 published such a type with its `stdout` and `command`. Of `message`
  only `role`, `content`, `id`, `type`, `model`, `stop_reason` and `usage` are
  published; the rest of the API's answer envelope (`diagnostics`,
  `context_management`, `stop_sequence`, …) stays, counted by name. A shape no
  measured transcript had — a hook type, a `message` key, a content block type
  — is listed under `unrecognised_shapes` and `prepare` adds a line `/share`
  relays; a content block of an unknown type is the conversation and is
  published as it is. None of the 181 sessions had one. Not covered: what is
  inside a content block, inside `usage`, inside the other kept attachments
  (`deferred_tools_delta`, `skill_listing`, `task_status`, …) and inside what a
  kept `system` record reports — a key that is new there is published unsaid,
  as in 0.12.0.
- **The hook approves an upload only to the plugin's own server**: the host of
  its MCP address on that address's port and, for the dedicated `share.` host,
  the domain it is on — `share.elasticflow.app` and `elasticflow.app` on 443
  unless `EF_SHARE_MCP_URL` names another server. 0.12.0 approved any
  `*.elasticflow.app` host on any port. It also approves nothing — `prepare`
  included — while the tool's work directory is inside the session's project,
  whether `EF_SHARE_WORK_DIR` or `TMPDIR` put it there and under whatever name
  the directory is given (a link, another letter case, the macOS data volume):
  the directory's real parents are compared with the project, not their paths.
  One layout is not judged: the temp folder below a session that is in the
  home folder or above it — that is where the machine keeps it (under the home
  folder on Windows), not a place a project named. So the steps ask for
  permission when you start Claude Code in a project that holds the work
  directory, or in the temp folder itself. A hook input that does not say
  where the session is approves nothing. The tool itself still sends to any
  ElasticFlow host you approve.
- **A result file is sent only while it holds what was listed.** `prepare`
  records a sha256 of the page and of each file it lists; `upload` compares
  what it read with it — 0.12.0 compared the length — and the local server the
  picture is taken from hands out a file only while it matches. A prepared
  directory made by 0.12.0 has no digests: its results are refused with "run
  prepare again".
- **The picture's local server answers only a request that has its token.**
  The files are served under a random token made for that one picture; a
  request without it gets no file, no wrapper page and no cross-origin header.
  In 0.12.0 any page open in your browser could read the result's files off
  the port while the picture was taken. The token is part of the address on
  the browser's command line: a program that can read that command line — your
  own, which can read the files on disk anyway; another user's, where the
  system shows it — can still use it for the seconds the capture runs. The
  browser is started with `--disable-background-networking`.
- **The copy of a session is written only into a directory that is yours.**
  The default directory is made by `mkdtemp`; an `--out` directory that exists
  must be your own before anything in it is touched, and is refused if it is
  not closed to other users after `prepare` closed it — 0.12.0 took an empty
  directory someone else had made in a shared temp folder and ignored a failed
  `chmod`. The cleanup of browser profiles a killed run left removes only a
  directory of your own that is such a profile — it holds the plugin's marker,
  or is one 0.12.0 left (the name `mkdtemp` gave it and the browser's
  `Local State` file), or holds nothing at all — no longer any
  `ef-share-preview-*` directory.

### Fixed
- An id named only by a sub-agent's meta file or a workflow run's record was
  learnt after the main transcript and the earlier sub-agents were written, so
  it stayed in them. Every such file is read in the first pass now, the run
  records whole.
- A sub-agent's description (500 characters), a workflow summary (600) and a
  phase's title and detail were cut before identifiers were replaced: an id the
  limit fell inside left its first characters behind. They are replaced first
  and cut after.
- A sub-agent record whose tool output was cut to fit the upload was written
  with U+2028 / U+2029 raw again, which the server reads as a line break (1 of
  181 measured sessions). Line separators are escaped last, as each transcript
  file is written.
- A desktop-app folder was read for the account's ids only in lower case
  (`Local-Agent-Mode-Sessions/<account>/<organisation>` was not).
- The release runbook's mirroring `rsync --delete` excluded neither the Codex
  plugin (`.agents/`, `share-codex/`) nor `share-antigravity/`: followed
  literally it removed them from the public repository.
- This file linked 0.5.0–0.7.0 to tags that never existed; they now link to
  the commit that published each.

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

<!-- Releases are tagged in elasticflowapp/plugins from v0.8.0 on. 0.5.0–0.7.0 were published
     before that: each links to the commit that published it (its share/ tree). -->
[Unreleased]: https://github.com/elasticflowapp/plugins/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.13.0
[0.12.2]: https://github.com/elasticflowapp/plugins/releases/tag/v0.12.2
[0.12.1]: https://github.com/elasticflowapp/plugins/releases/tag/v0.12.1
[0.12.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.12.0
[0.11.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.11.0
[0.10.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.10.0
[0.9.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.9.0
[0.8.0]: https://github.com/elasticflowapp/plugins/releases/tag/v0.8.0
[0.7.0]: https://github.com/elasticflowapp/plugins/tree/4094bb4cde32d3ad6b444da1c06a9ca840dd356b/share
[0.6.0]: https://github.com/elasticflowapp/plugins/tree/54ea8d233f6a1c2b5e84713040908348abdec7fd/share
[0.5.0]: https://github.com/elasticflowapp/plugins/tree/70718c58120ff0c54d786931dfb370fb418c2290/share
