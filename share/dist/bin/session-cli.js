// packages/ef-share-plugin/bin/session-cli.ts
//
// `ef-share-session` — the deterministic half of /share. The launcher
// `bin/ef-share-session` puts it on the Bash tool's PATH (Claude Code adds a
// plugin's bin/ there), so the command works the same from the terminal CLI and
// the desktop app, with no $CLAUDE_PLUGIN_ROOT — which the Bash tool does not have.
// (The TEXT of a command or skill is another matter: there `${CLAUDE_PLUGIN_ROOT}`
// is replaced with the plugin's path before the model reads it — measured
// 2026-11-16 on Claude Code 2.1.281 with a probe plugin; the bare
// `$CLAUDE_PLUGIN_ROOT` form is not. share.md's `command not found` fallback,
// `node "${CLAUDE_PLUGIN_ROOT}/bin/ef-share-session" …`, relies on exactly that.)
//
//   ef-share-session prepare [--transcript <path>] [--out <dir>] [--result <file>]…
//   ef-share-session show automations|chapters --dir <dir>
//   ef-share-session upload --dir <dir> --url <uploadUrl> --ticket <ticket> [--results none|1,2]
//
// The argument grammar lives in src/lib/cli-args.ts and is shared with the hook
// that approves these commands: an option that takes one value may be given
// once, an unknown option is an error.
//
// Every command prints one JSON object on stdout. Exit code:
//   0  done
//   2  the caller must fix something and can — the message says what (a wrong
//      argument, a directory that is not a prepared one, an authored file with
//      a mistake, an upload over the size the endpoint takes)
//   1  everything else: the upload was sent and the server refused it (the
//      printed object has `status` and `notes`), the request got no answer
//      (`error` says so), or an unexpected failure
//
// `upload` prints the fields the publishing agent decides on first and keeps its
// output inside what Claude Code shows of a command (src/lib/upload-digest.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { prepareSession, summarizeManifest, isPreparedDir } from "../src/lib/prepare.js";
import { uploadPrepared, parseResultSelection } from "../src/lib/upload.js";
import { digestUpload } from "../src/lib/upload-digest.js";
import { parseCommandArgs, flag, UsageError, USAGE } from "../src/lib/cli-args.js";
import { PREPARED_NAME, preparedWorkDir, readPreparedJson, requirePreparedDir } from "../src/lib/prepared-dir.js";
function out(value) {
    process.stdout.write(JSON.stringify(value, null, 1) + "\n");
}
/** Prepared copies older than this are removed the next time prepare runs. */
const PREPARED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * A prepared directory is a copy of a session. Nothing else removes it, so each
 * prepare run clears the ones it left in its work directory more than a day
 * ago: directories with the name prepare gives them, that hold a prepare
 * manifest, and nothing else.
 */
export function sweepPreparedDirs(workDir, now = Date.now()) {
    let names;
    try {
        names = fs.readdirSync(workDir);
    }
    catch {
        return 0;
    }
    let removed = 0;
    for (const name of names) {
        if (!PREPARED_NAME.test(name))
            continue;
        const dir = path.join(workDir, name);
        try {
            const st = fs.lstatSync(dir);
            if (!st.isDirectory() || now - st.mtimeMs < PREPARED_MAX_AGE_MS || !isPreparedDir(dir))
                continue;
            fs.rmSync(dir, { recursive: true, force: true });
            removed++;
        }
        catch { /* gone, or not ours to remove */ }
    }
    return removed;
}
async function cmdPrepare(args) {
    const transcript = flag(args, "transcript") ?? process.env.EF_SHARE_TRANSCRIPT_PATH;
    if (!transcript) {
        throw new UsageError("could not resolve this session's transcript: pass --transcript <path> " +
            "(the <EF-SHARE-CURRENT transcript_path=…> marker in context has it). Not guessing.");
    }
    if (!fs.existsSync(transcript))
        throw new UsageError(`transcript not found: ${transcript}`);
    let outDir = flag(args, "out");
    if (!outDir) {
        const workDir = preparedWorkDir();
        sweepPreparedDirs(workDir);
        const sid = crypto.createHash("sha256").update(path.resolve(transcript)).digest("hex").slice(0, 8);
        outDir = path.join(workDir, `ef-share-${sid}-${crypto.randomBytes(3).toString("hex")}`);
    }
    // Claude Code's own record of the account this machine is signed in to: its ids are
    // replaced wherever they stand in what is published (sanitize.ts, takeAccountFields).
    const accountFile = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
    const manifest = await prepareSession({ transcriptPath: transcript, outDir, extraResults: args.flags.get("result") ?? [], accountFile });
    out(summarizeManifest(manifest));
}
function cmdShow(args) {
    const dir = flag(args, "dir");
    if (!dir)
        throw new UsageError("show needs --dir <prepared dir>");
    requirePreparedDir(dir); // prepare's own directory, private, the person's: exit 2 naming what is wrong
    const what = args.positional[0];
    if (what === "automations") {
        const c = readPreparedJson(path.join(dir, "extract", "automations.json"));
        if (!c)
            throw new UsageError(`${dir} has no automation candidates — run "ef-share-session prepare" again`);
        const count = new Map();
        for (const o of c.occurrences)
            count.set(o.kind_id, (count.get(o.kind_id) ?? 0) + 1);
        out({
            write_to: path.join(dir, "authored", "automations.json"),
            format: { kinds: { "<kind_id>": { title: "≤200 chars, plain English", why: "one sentence, ≤400 chars", category: "optional", confidence: "optional: low|medium|high" } } },
            kinds: c.kinds.map((k) => ({ kind_id: k.kind_id, floor_title: k.title, ...k.signature, firings: count.get(k.kind_id) ?? 0 })),
        });
    }
    else if (what === "chapters") {
        const c = readPreparedJson(path.join(dir, "extract", "chapters.json"));
        if (!c)
            throw new UsageError(`${dir} has no chapter candidates — run "ef-share-session prepare" again`);
        out({
            write_to: path.join(dir, "authored", "chapters.json"),
            format: { language: "optional, e.g. ru", chapters: [{ start_record_ref: "<uuid of the chapter's first turn>", title: "≤120 chars, English", hint: "≤200 chars, session language — required" }] },
            turns: c.turns,
        });
    }
    else
        throw new UsageError(`show takes "automations" or "chapters"`);
}
async function cmdUpload(args) {
    const dir = flag(args, "dir");
    const url = flag(args, "url");
    const ticket = flag(args, "ticket");
    if (!dir || !url || !ticket)
        throw new UsageError("upload needs --dir <prepared dir> --url <uploadUrl> --ticket <ticket>");
    let resultIds;
    try {
        resultIds = parseResultSelection(flag(args, "results"));
    }
    catch (e) {
        throw new UsageError(e.message);
    }
    // `--pictures none`: publish the results without taking their preview pictures
    const pictures = flag(args, "pictures");
    if (pictures !== undefined && pictures !== "none" && pictures !== "auto")
        throw new UsageError(`--pictures takes "auto" or "none", got "${pictures}"`);
    let outcome;
    try {
        outcome = await uploadPrepared({ dir, url, ticket, resultIds, ...(pictures === "none" ? { capturePreview: null } : {}) });
    }
    catch (e) {
        // Only a request that got no answer is reworded here. Everything else — a wrong
        // argument, a refused directory, a redirect that was not followed — says what it is.
        const cause = e.cause;
        if (e instanceof UsageError || !(e instanceof TypeError) || !cause)
            throw e;
        // No answer came back (no network, a refused or reset connection, a timeout). Node
        // says only "fetch failed"; the reason is in `cause` (for a host with several
        // addresses it is a list of failures, one per address).
        const first = cause?.errors?.[0] ?? cause;
        const reason = first?.code ?? first?.message;
        const why = reason ? ` (${String(reason).slice(0, 120)})` : "";
        throw new Error(`the upload request got no answer: ${e.message}${why}. Nothing was published. ` +
            `Check the connection, then call share_begin again and re-run upload with the new values`);
    }
    // The decision fields first and the whole output inside what the agent is shown —
    // see upload-digest.ts. The full reply is saved in the prepared directory.
    process.stdout.write(digestUpload(path.resolve(dir), outcome) + "\n");
    if (!outcome.ok)
        process.exitCode = 1;
}
async function main(argv) {
    const [cmd, ...rest] = argv;
    const args = parseCommandArgs(cmd, rest);
    if (cmd === "prepare")
        await cmdPrepare(args);
    else if (cmd === "show")
        cmdShow(args);
    else if (cmd === "upload")
        await cmdUpload(args);
    else
        throw new UsageError(USAGE);
}
/** The program. Called by the launcher (bin/ef-share-session); importing this module runs nothing. */
export async function run(argv) {
    try {
        await main(argv);
    }
    catch (err) {
        process.stdout.write(JSON.stringify({ error: err.message }, null, 1) + "\n");
        process.exitCode = err instanceof UsageError ? 2 : 1;
    }
}
// `node dist/bin/session-cli.js …` — the same program without the launcher.
if (process.argv[1] && /session-cli\.[cm]?js$/.test(process.argv[1])) {
    void run(process.argv.slice(2));
}
