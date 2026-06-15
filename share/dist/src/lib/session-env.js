import fs from "node:fs/promises";
function shQuote(value) {
    // wrap in single quotes, escaping embedded single quotes via the '\'' idiom
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function buildSessionEnvLines(s) {
    return [
        `export EF_SHARE_TRANSCRIPT_PATH=${shQuote(s.transcript_path)}`,
        `export EF_SHARE_SESSION_ID=${shQuote(s.session_id)}`,
    ];
}
/** Append per-session export lines to the CLAUDE_ENV_FILE (session-scoped). No-op if no path. */
export async function appendSessionEnv(s, envFilePath = process.env.CLAUDE_ENV_FILE) {
    if (!envFilePath)
        return;
    await fs.appendFile(envFilePath, buildSessionEnvLines(s).join("\n") + "\n");
}
