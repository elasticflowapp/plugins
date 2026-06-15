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

In any Claude Code session, type `/share`. The agent inspects the session,
proposes a title / summary / tags, asks for visibility (public, private, or
unlisted), and returns a share URL.

On the first `/share` of a session Claude Code prompts you to authorize the
ElasticFlow Share MCP via OAuth in your browser — approve once and you are set.

## What it connects to

- **MCP server:** `https://share.elasticflow.app/mcp` (HTTP transport, OAuth on
  first use). Override for local development with the `EF_SHARE_MCP_URL`
  environment variable (e.g. `http://localhost:3005/api/mcp`).

## Requirements

- Claude Code with plugin support.
- Node.js (used by the bundled session hooks — no extra packages to install;
  the plugin ships its own compiled hook scripts).

## Uninstall

```bash
claude plugin uninstall ef-share@elasticflowapp
```
