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
/**
 * Where the PreToolUse hook lets an upload go WITHOUT a prompt: an ElasticFlow
 * host over https, and nothing else. The tool also sends to a loopback server
 * for local development (isAllowedUploadUrl), over plain http too — that is a
 * destination the person approves, not one an injected command gets for free
 * (review 2026-11-20, A-7). `127.1` and the other spellings of a loopback
 * address reach here already normalised by the URL parser.
 */
export function isAutoApprovedUploadUrl(raw) {
    if (!isAllowedUploadUrl(raw))
        return false;
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && !isLoopbackHost(host) && isElasticFlowHost(host);
}
