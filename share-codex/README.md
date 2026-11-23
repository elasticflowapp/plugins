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
updates the same session under the same id; the link reads as the title of the
latest publish, and an earlier link redirects to it.

The upload is the one step that needs network access: with the default sandbox
Codex asks you to approve that command.

## What is uploaded

The session's record as Codex wrote it on your machine (the rollout file). That
is the conversation — your messages, the agent's messages, the commands and tool calls **with everything they
printed**, the model name and token counts — and, with it, Codex's bookkeeping
around the conversation: the model-facing copy of each step, the copy of your
`AGENTS.md` and the environment description it injects, encrypted reasoning.

Three things are taken out before the upload and stay on your machine: Codex's
own instructions to the model (its base instructions and developer messages,
the tool catalogue among them), your Codex account ids, and your usage limits.

What is published is chosen on the server: the conversation, the skills that
were loaded, the model and the token counts. The rest of the upload is read past
— it is not kept and not shown. If a command printed a secret or the contents of
a private file, that output is part of the conversation. A step of a kind the
server does not know shows on the page as a step without content.

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
