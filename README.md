# ElasticFlow Claude Code plugins

Public [Claude Code](https://code.claude.com) plugin marketplace for ElasticFlow.

## Install

```bash
claude plugin marketplace add elasticflowapp/plugins
claude plugin install ef-share@elasticflowapp
```

Or from inside a Claude Code session:

```
/plugin marketplace add elasticflowapp/plugins
/plugin install ef-share@elasticflowapp
```

## Plugins

| Plugin | Description |
|--------|-------------|
| [`ef-share`](./share) | Share Claude Code sessions to ElasticFlow Share. Adds the `/share` command and the ElasticFlow Share MCP (`https://share.elasticflow.app/mcp`); authorizes via OAuth on first use. |

The marketplace manifest is [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json); each plugin lives in its own subdirectory.
