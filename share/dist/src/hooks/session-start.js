import { appendSessionEnv } from "../lib/session-env.js";
async function main() {
    const raw = await new Promise((resolve) => {
        let buf = "";
        process.stdin.on("data", (c) => { buf += c; });
        process.stdin.on("end", () => resolve(buf));
    });
    try {
        const payload = JSON.parse(raw);
        if (payload?.transcript_path && payload?.session_id) {
            await appendSessionEnv({ transcript_path: payload.transcript_path, session_id: payload.session_id });
        }
    }
    catch (err) {
        process.stderr.write(`ef-share session-start hook error: ${err}\n`);
    }
    process.stdout.write("{}\n");
}
main();
