# ElasticFlow plugins

Public plugin marketplace for ElasticFlow: the clients that connect your coding agent to ElasticFlow.

## Claude Code

```bash
claude plugin marketplace add elasticflowapp/plugins
claude plugin install ef-share@elasticflowapp
```

Or from inside a Claude Code session:

```
/plugin marketplace add elasticflowapp/plugins
/plugin install ef-share@elasticflowapp
```

## Codex (CLI and desktop app)

```bash
codex plugin marketplace add elasticflowapp/plugins
codex plugin add ef-share@elasticflowapp
codex mcp login share
```

One install serves both Codex CLI and the Codex desktop app.

## Antigravity (app, `agy` CLI and IDE)

```bash
git clone https://github.com/elasticflowapp/plugins
agy plugin install ./plugins/share-antigravity
```

One install serves the Antigravity app, the `agy` CLI and the IDE. Antigravity asks you to sign in the first time the plugin talks to ElasticFlow Share.

## Plugins

| Plugin | For | Description |
|--------|-----|-------------|
| [`ef-share`](./share) | Claude Code | Share Claude Code sessions to ElasticFlow Share. Adds the `/share` command and the ElasticFlow Share MCP (`https://share.elasticflow.app/mcp`); authorizes via OAuth on first use. |
| [`ef-share`](./share-codex) | Codex | Share Codex sessions to ElasticFlow Share. Adds the `share` skill (`$share`, or just ask) and the ElasticFlow Share MCP (`https://share.elasticflow.app/mcp`); authorize once with `codex mcp login share`. |
| [`ef-share`](./share-antigravity) | Antigravity | Share Antigravity sessions to ElasticFlow Share. Adds the `share` skill (`/share`, or just ask) and the ElasticFlow Share MCP (`https://share.elasticflow.app/mcp`); Antigravity asks for the sign-in on first use. |

Each agent reads its own marketplace manifest — Claude Code [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json), Codex [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json) — and Antigravity installs the plugin's own folder ([`share-antigravity/plugin.json`](./share-antigravity/plugin.json)). Each plugin lives in its own subdirectory.
