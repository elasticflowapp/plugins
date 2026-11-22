// packages/ef-share-plugin/src/lib/upload-url.ts
//
// Where an upload may go. Its own module because two programs ask: the tool
// that sends the bytes (upload.ts) and the hook that approves the command
// (hooks/pre-tool-use.ts) — the hook must not pull in the upload code to ask.
function isLoopbackHost(host) {
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
function isElasticFlowHost(host) {
    return host === "elasticflow.app" || host.endsWith(".elasticflow.app");
}
/**
 * The upload goes only to ElasticFlow Share: an elasticflow.app host over https,
 * or a loopback dev server. No credentials in the URL — `https://elasticflow.app@evil.example/`
 * parses with host evil.example and is refused by the host rule; a URL that
 * carries a user or password at all is refused too.
 */
export function isAllowedUploadUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        return false;
    }
    if (u.username || u.password)
        return false;
    const host = u.hostname.toLowerCase();
    if (isLoopbackHost(host))
        return u.protocol === "http:" || u.protocol === "https:";
    return isElasticFlowHost(host) && u.protocol === "https:";
}
/** The plugin's MCP server when EF_SHARE_MCP_URL names no other — the default .claude-plugin/plugin.json declares. */
export const DEFAULT_MCP_URL = "https://share.elasticflow.app/mcp";
/** The address of the plugin's MCP server, as its manifest resolves it: `${EF_SHARE_MCP_URL:-<default>}`. */
export function mcpServerUrl(env = process.env) {
    return env["EF_SHARE_MCP_URL"] || DEFAULT_MCP_URL;
}
/**
 * Where the PreToolUse hook lets an upload go WITHOUT a prompt: the plugin's own
 * server, and nothing else. `share_begin` on that server returns the upload
 * address, and the web app it names is on the same host — or, for the dedicated
 * `share.` host, on the domain it belongs to (the MCP is served at
 * share.elasticflow.app/mcp, the web app and its upload door at
 * elasticflow.app/share: docs/adr/0015). So approved are an https address on the
 * MCP server's host, or on its parent when that host begins with `share.`, on
 * the MCP server's port.
 *
 * Until 0.12.1 this was any `*.elasticflow.app` host on any port (release review
 * 2026-11-20, note 10): one stray subdomain, or one other service on a known
 * host, was a place an injected command could send a session without a prompt.
 * The tool itself still sends to any ElasticFlow host, and to a loopback server
 * for local development, over plain http too (isAllowedUploadUrl) — those are
 * destinations the person approves (review 2026-11-20, A-7); a server that is
 * not an ElasticFlow one over https approves nothing. `127.1` and the other
 * spellings of a loopback address reach here already normalised by the URL parser.
 */
export function isAutoApprovedUploadUrl(raw, mcpUrl = mcpServerUrl()) {
    if (!isAllowedUploadUrl(raw))
        return false;
    let server;
    try {
        server = new URL(mcpUrl);
    }
    catch {
        return false;
    }
    const serverHost = server.hostname.toLowerCase();
    if (server.protocol !== "https:" || server.username || server.password || isLoopbackHost(serverHost) || !isElasticFlowHost(serverHost))
        return false;
    const hosts = [serverHost, ...(serverHost.startsWith("share.") ? [serverHost.slice("share.".length)] : [])];
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && !isLoopbackHost(host) && isElasticFlowHost(host) && hosts.includes(host) && u.port === server.port;
}
