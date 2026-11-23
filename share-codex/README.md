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
asks for the visibility (public, unlisted or private), what to redact and —
when the session made an HTML page — whether to publish it too, and answers
with the link. Publishing the same session again after more work
updates the same session under the same id; the link reads as the title of the
latest publish, and an earlier link redirects to it.

The upload needs network access: with the default sandbox Codex asks you to
approve that command. An upload that carries a page is a command of its own
(`send-results`), and Codex is told to ask you for it by itself, for that one
run.

## Publishing a page the session made

When the session wrote an HTML page — a report, a demo, a small tool — it can be
published with the session as a **result**: a reader sees a picture of the page
at the top of the session and can run the page itself, in a sandboxed frame.

After the session is uploaded, Codex lists the pages the session wrote that
are still files in the folder the session ran in, each with **exactly the files it would
publish, by name**: the page and the local files it loads from its own folder
(scripts, styles, images, data) — never the folder around it — the hosts it
loads from the network, and what it refers to that will not be published. Then
it asks. Nothing of a page is sent before you say yes, and saying yes to the
session is not saying yes to a result.

- A result is published **byte for byte**: nothing in it can be redacted. If a
  file holds what looks like a secret, you are told before it is published.
- A picture of the page is taken on your machine — the page is opened once,
  without a window, in your installed Chrome, Edge, Chromium or Brave — and
  published with it. You are told where the picture is before anything is
  public. No such browser, or `EF_SHARE_PREVIEW=off`: the result is published
  without a picture.
- A browser does not start inside Codex's sandbox. The command that sends a
  result then stops before sending anything and says so: Codex asks you to
  approve running it outside the sandbox, or you publish without a picture.
- A page that is not listed — one a script made, one outside the folder the session ran in — is
  listed when you name it. A page that is a symbolic link is not published.
- A private session shows its results to no one. Publishing the session again
  without a result takes that result down.
- Up to 12 results in one publish; a page at most 8 MB, a result at most 20 MB
  and 81 files.

The pages are named by the server, from the session's record: the plugin does
not read the conversation. A name from the server is used only when it is a
file inside the folder the session ran in — and not in a hidden or a
dependency folder there (`node_modules`); anything else is counted and never
opened. Your yes is a yes to the list you were shown: if the list changes
before the files are sent — a page is added, a file is edited — nothing is
sent until you have seen the new one.

## What is uploaded

The session's record as Codex wrote it on your machine (the rollout file). That
is the conversation — your messages, the agent's messages, the commands and tool calls **with everything they
printed**, the model name and token counts — and, with it, Codex's bookkeeping
around the conversation: the model-facing copy of each step, the copy of your
`AGENTS.md` and the environment description it injects, its record of your
settings (the commands you have approved among them), encrypted reasoning.

Three things are taken out before the upload and stay on your machine: Codex's
own instructions to the model (its base instructions and developer messages,
the tool catalogue and the skills listing — also where Codex's record of its
state repeats them), your Codex account ids, and your usage limits. A tool
description the session itself printed — the output of a tool search the agent
ran — is part of the conversation, like any other output.

What is published is chosen on the server: the conversation, the agent's
reasoning summaries where Codex recorded one, the skills that were loaded, the
model and the token counts. The rest of the upload is read past
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
