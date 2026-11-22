# ef-share — Share Claude Code sessions to ElasticFlow

`ef-share` is a Claude Code plugin that publishes the current Claude Code
session to **ElasticFlow Share**. It adds a `/share` command, two helper
skills (chapter authoring + automation classification), and connects to the
ElasticFlow Share MCP at `https://share.elasticflow.app/mcp`.

## Install

In your terminal:

```bash
claude plugin marketplace add elasticflowapp/plugins
claude plugin install ef-share@elasticflowapp
```

Or, inside a Claude Code session:

```
/plugin marketplace add elasticflowapp/plugins
/plugin install ef-share@elasticflowapp
```

## Use

In any Claude Code session — the terminal CLI or the desktop app — type
`/share`. The agent prepares the session, tells you what will and will not
leave your machine, asks for visibility (public, private, or unlisted) and
returns a share URL.

**What is published:** the conversation, each sub-agent's transcript, and how
the session was run: commands such as `/goal`, the plugins that were enabled
(name, source address, version), the list of skills and the text of the skills
it used, and the definitions of the MCP tools that were connected. Folder paths
of your machine that appear in the session are part of it. `/share` names the
plugins before anything is sent.

**Results are opt-in.** If the session made an HTML page, `/share` asks whether
to publish that result as well, and lists by name every file it would include.
Nothing is added without your yes in that run. A result is published as it is —
it cannot be redacted — and a private session shows it to no one. A picture of
the page is taken on your machine when you publish it and shown to readers at
the top of the session, before they run anything. To take it the page is opened
once in your installed Chrome, Edge, Chromium or Brave, without a window; you
are told what the picture shows and where the file is before anything is
public, and can publish without it.

**What stays on your machine:** the records Claude Code keeps for itself beside
the conversation — the system prompt, the instruction files it loaded
(`CLAUDE.md`, memory), your account email and organisation ids, the
remote-control URL and the raw API requests. Where Claude Code copied an
instruction file into one of its own messages, that copy is cut as well. The
organisation id, account id and e-mail of the accounts every Claude app on this
machine is signed in to — the Claude Code you run `/share` in, the terminal
Claude Code, and the Claude desktop app, which can be signed in to a different
account — and the ids a session's own records and folders name, are replaced by
a placeholder where they stand in what is published — a folder path, a
command's output, the conversation itself. `/share` reads them from those apps'
own account records and prints none of them; it tells you how many records
stayed, by kind, and how many places were cut or replaced. Of a hook firing of
a kind this version has not seen only its name is published, and of a message
only the fields that are read — not the rest of the API's answer around it;
`/share` says so when it meets something new there.

**What that does not cover:** text that is part of the conversation. If one of
your hooks injects memory notes or rules into the session, that text is in the
session; `/share` tells you how many such injections there are, and you can
redact them before publishing. The same goes for an instruction file that you
or the agent opened or quoted during the session, and for a remote-control link
that was typed into a command: they are conversation. So is the address of
any other account — one you no longer use, or one no Claude app on this
machine is signed in to now — and an identifier written some other way than
Claude Code records it (an id without its hyphens, an address spelt out): look
through the redaction candidates `/share` shows.

On the first `/share` of a session Claude Code prompts you to authorize the
ElasticFlow Share MCP via OAuth in your browser — approve once and you are set.

## What it connects to

- **MCP server:** `https://share.elasticflow.app/mcp` (HTTP transport, OAuth on
  first use). Override for local development with the `EF_SHARE_MCP_URL`
  environment variable (e.g. `http://localhost:3005/api/mcp`).

## Requirements

- Claude Code with plugin support.
- Node.js 18 or later on your PATH. It runs the plugin's session tool and its
  hooks, and the upload uses Node's built-in `fetch`. Nothing else to install:
  the plugin ships compiled. It is developed and tested on Node 25.

## Uninstall

```bash
claude plugin uninstall ef-share@elasticflowapp
```
