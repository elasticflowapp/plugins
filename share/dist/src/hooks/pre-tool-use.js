// PreToolUse hook (ADR-0019): auto-approve ef-share's OWN session-transcript upload.
//
// Installing ef-share is consent to publish sessions, and uploading the transcript
// is the irreducible core of /share. Without this, a non-technical user hits a
// permission prompt (or, in auto-mode, a hard classifier denial) on the upload curl
// mid-/share and cannot publish. This hook authorizes ONLY the plugin's own ticketed
// upload — a single clean curl to the Share upload endpoint carrying an upload
// ticket and the session.jsonl field — and stays neutral on everything else, so it
// can never be used to approve an arbitrary command.
/**
 * True iff `command` is exactly ef-share's own transcript upload: a single `curl`
 * to the Share upload endpoint (an `*.elasticflow.app` host, or localhost for the
 * EF_SHARE_MCP_URL dev override) with an `X-Upload-Ticket` header and the
 * `session.jsonl` file field — and NO shell chaining/redirection that could do
 * anything beyond that one request.
 */
export function isShareUpload(command) {
    if (!command)
        return false;
    if (!/^\s*curl\b/.test(command))
        return false;
    // Target must be the Share upload endpoint: an elasticflow.app host (or a
    // subdomain), or a localhost dev override — with "upload" in the path. The
    // host pattern requires elasticflow.app to be the true registrable host, so
    // lookalikes like "evilelasticflow.app" do NOT match.
    const uploadUrl = /https?:\/\/(?:(?:[a-z0-9-]+\.)*elasticflow\.app|localhost|127\.0\.0\.1)(?::\d+)?\/[^"'\s]*upload/i;
    if (!uploadUrl.test(command))
        return false;
    // Must carry the single-use upload ticket header and the transcript file field.
    if (!/-H\s+["']X-Upload-Ticket:/i.test(command))
        return false;
    if (!/-F\s+["']session\.jsonl=@/i.test(command))
        return false;
    // Injection guard: strip quoted arguments, then forbid ANY shell control operator
    // in what remains. This makes `curl …upload… ; rm -rf /` (and &&, |, $(), backticks,
    // redirects, newlines) fail to match. The legitimate `;type=application/jsonl`
    // lives inside the -F "..." quotes and is removed by the strip, so it is allowed.
    const unquoted = command.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
    if (/[;&|`<>\n]|\$\(/.test(unquoted))
        return false;
    return true;
}
export function preToolUseOutput(payload) {
    if (payload?.tool_name !== "Bash")
        return {};
    if (!isShareUpload(payload.tool_input?.command))
        return {};
    return {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "ef-share: authorized its own session-transcript upload to ElasticFlow Share. " +
                "Installing ef-share authorizes publishing your sessions; this allows only the " +
                "plugin's ticketed upload to the Share endpoint — no other command.",
        },
    };
}
async function main() {
    const raw = await new Promise((resolve) => {
        let buf = "";
        process.stdin.on("data", (c) => { buf += c; });
        process.stdin.on("end", () => resolve(buf));
    });
    let out = {};
    try {
        out = preToolUseOutput(JSON.parse(raw));
    }
    catch (err) {
        process.stderr.write(`ef-share pre-tool-use hook error: ${err}\n`);
    }
    process.stdout.write(JSON.stringify(out) + "\n");
}
if (process.argv[1] && process.argv[1].includes("pre-tool-use")) {
    main();
}
