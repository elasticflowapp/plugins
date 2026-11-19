# ef-share — publish Codex sessions to ElasticFlow Share

`ef-share` is a Codex plugin that publishes the session you are in to
**ElasticFlow Share**: a readable page with the conversation, the commands and
tools it ran, the skills and MCP servers behind it, and a link to pass on.
**Codex CLI** and the **Codex desktop app** read plugins, skills and MCP servers
from the same Codex home, so one install serves both.

It bundles the `share` skill and the ElasticFlow Share MCP server
(`https://share.elasticflow.app/mcp`).

## Install

```bash
codex plugin marketplace add elasticflowapp/plugins
codex plugin add ef-share@elasticflowapp
```

In the desktop app the plugin then appears in the Plugins directory under
**ElasticFlow**; restart the app if it was open during the install.

Sign in once — the browser opens the ElasticFlow sign-in and the consent screen
for the `share:read` and `share:write` scopes:

```bash
codex mcp login share
```

(In the app: **Connect** on the plugin's MCP server.)

Requires Node.js 18 or newer on `PATH`.

## Use

In any session, ask Codex to publish it, or invoke the skill:

```
$share
```

Codex snapshots the session, uploads it, proposes a title, summary and tags,
asks for the visibility (public, unlisted or private) and what to redact, and
answers with the link. Publishing the same session again after more work
updates the same page.

The upload is the one step that needs network access: with the default sandbox
Codex asks you to approve that command.

## What is uploaded

The session as it was recorded: your messages (with an image attached inline,
if there is one), the agent's messages, and the commands and tool calls **with
everything they printed**, plus the model name and token counts. If a command printed a secret or the contents of a private
file, that output is part of the session.

Before the upload the plugin leaves out what Codex adds for the model and for
itself: its base instructions and developer messages, the copy of your
`AGENTS.md` it injects into the conversation, the tool catalogue, encrypted
reasoning, your account ids and your usage limits. A step of a kind this version
of the plugin does not know is uploaded as its name only, and shows on the page
as a step without content.

Redaction happens on the server: the snapshot is uploaded first, then Codex
shows you what the server flagged, and what you choose to redact is removed
before the session is stored or shown. Look at that list before choosing
`public`.

Inside a session the plugin publishes that session and no other: it is found by
its own id (`CODEX_THREAD_ID`), never by "the most recent file".

## Not covered yet

- The threads of spawned sub-agents (the main thread shows the spawn as a tool
  call).
- The Automations panel — Codex hooks are not collected.
- Images attached to prompts have not been checked and may not appear.
