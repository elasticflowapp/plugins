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

The first time the plugin talks to ElasticFlow Share, Antigravity asks you to
sign in — your browser opens the ElasticFlow sign-in and consent screen.

## Use

In any session, ask the agent to publish it, or type:

```
/share
```

The agent snapshots the session, uploads it, proposes a title, summary and tags,
asks for the visibility (public, unlisted or private) and what to redact, and
answers with the link. Publishing the same session again after more work
updates the same session under the same id; the link reads as the title of the
latest publish, and an earlier link redirects to it.

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
- The Skills and Automations panels of the page.
- The consumer Gemini app (web, mobile, Mac): it has no plugins and keeps no
  session file on your machine, so there is nothing for a plugin to publish.

## Requirements

Antigravity 2.x (app) or `agy` 1.5+, and Node.js 18 or newer on your `PATH`.
