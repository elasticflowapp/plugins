# ElasticFlow Share for Antigravity

Publish an Antigravity session to [ElasticFlow Share](https://elasticflow.app/share):
a readable page with the conversation, the commands and tools it ran, and a link
to pass on. One plugin serves the Antigravity app, the `agy` CLI and the IDE —
they share one plugin folder.

## Install

Get the plugin's folder (`share-antigravity` in
[elasticflowapp/plugins](https://github.com/elasticflowapp/plugins)) and install
it from a terminal:

```bash
git clone https://github.com/elasticflowapp/plugins
agy plugin install ./plugins/share-antigravity
```

or, inside the `agy` CLI, `/plugin` → **Install from local directory…**. The app,
the CLI and the IDE read the same plugin folder, so one install serves all three.

Sign in once. In the `agy` CLI type `/mcp`, choose the `ef-share_share` server
(once it has started it is marked "Auth Needed"), press Enter and pick
**Authenticate**. Your browser
opens the ElasticFlow sign-in and consent screen, and the CLI then asks for an
authorization code to paste. That is how it goes in `agy` 1.5.15.

## Use

In any session, ask the agent to publish it, or type:

```
/share
```

The agent snapshots the session, uploads it, proposes a title, summary and tags,
asks for the visibility (public, unlisted or private), what to redact and —
when the session made an HTML page — whether to publish it too, and answers
with the link. Publishing the same session again after more work
updates the same session under the same id; the link reads as the title of the
latest publish, and an earlier link redirects to it.

## Publishing a page the session made

When the session wrote an HTML page — a report, a demo, a small tool — it can be
published with the session as a **result**: a reader sees a picture of the page
at the top of the session and can run the page itself, in a sandboxed frame.

After the session is uploaded, the agent lists the pages the session wrote that
are still files in the folder the conversation runs in, each with **exactly the files it would
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
- A page that is not listed — one a script made, one outside the folder the conversation runs in — is
  listed when you name it. A page that is a symbolic link is not published.
- A private session shows its results to no one. Publishing the session again
  without a result takes that result down.
- Up to 12 results in one publish; a page at most 8 MB, a result at most 20 MB
  and 81 files.

The pages are named by the server, from the session's record: the plugin does
not read the conversation. A name from the server is used only when it is a
file inside the folder the conversation runs in — and not in a hidden or a
dependency folder there (`node_modules`); anything else is counted and never
opened. Your yes is a yes to the list you were shown: if the list changes
before the files are sent — a page is added, a file is edited — nothing is
sent until you have seen the new one.

## What is uploaded

The conversation's record as Antigravity wrote it on your machine (its
`transcript_full.jsonl`): your messages, the agent's messages and reasoning
notes, the commands and tool calls **with everything they printed**, the model
name and token counts, and the system notes Antigravity adds to the
conversation. One record is added in front: the conversation's id, the folder
the publish was run from and the Antigravity version.

What is published is chosen on the server: the conversation, the model and the
token counts. The rest of the upload is read past — it is not kept and not
shown. If a command printed a secret or the contents of a private file, that
output is part of the conversation.

Redaction happens on the server: the snapshot is uploaded first, then the agent
shows you what the server flagged, and what you choose to redact is removed
before the session is stored or shown. Look at that list before choosing
`public`.

Inside a session the plugin publishes that session and no other: it is found by
its own id (`ANTIGRAVITY_CONVERSATION_ID`), never by "the most recent file".

## Not covered yet

- Images attached to prompts or returned by tools (they are files beside the
  transcript; the page says an image was there).
- The conversations of spawned sub-agents (the main conversation shows the spawn
  as a tool call).
- The Automations panel of the page, and where a skill came from: the Skills
  panel lists the skills the session read, without their source.
- The consumer Gemini app (web, mobile, Mac): it has no plugins and keeps no
  session file on your machine, so there is nothing for a plugin to publish.

## Requirements

Antigravity 2.x (app) or `agy` 1.5+, and Node.js 18 or newer on your `PATH`.
