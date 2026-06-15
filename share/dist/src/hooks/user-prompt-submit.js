export function isShareCommand(prompt) {
    if (!prompt)
        return false;
    return /^\s*\/(?:ef-share:)?share\b/.test(prompt);
}
function attr(value) {
    return (value ?? "").replace(/"/g, "&quot;");
}
export function promptSubmitOutput(payload) {
    if (!isShareCommand(payload.prompt) || !payload.transcript_path)
        return {};
    const marker = `<EF-SHARE-CURRENT transcript_path="${attr(payload.transcript_path)}" ` +
        `session_id="${attr(payload.session_id)}" cwd="${attr(payload.cwd)}" />`;
    return {
        hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: `The current Claude Code session for /share is: ${marker} ` +
                `Use this transcript_path; do NOT read ~/.cache/ef-share/active.json.`,
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
        out = promptSubmitOutput(JSON.parse(raw));
    }
    catch (err) {
        process.stderr.write(`ef-share user-prompt-submit hook error: ${err}\n`);
    }
    process.stdout.write(JSON.stringify(out) + "\n");
}
if (process.argv[1] && process.argv[1].includes("user-prompt-submit")) {
    main();
}
