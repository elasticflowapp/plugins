// PreToolUse hook (ADR-0019): auto-approve ef-share's OWN publishing steps.
//
// Installing ef-share is consent to publish sessions, and preparing + uploading
// the transcript is the irreducible core of /share. Without this, a
// non-technical user hits a permission prompt (or, in auto-mode, a hard
// classifier denial) mid-/share and cannot publish. The hook authorizes ONLY the
// plugin's own steps and stays neutral on everything else:
//
//   Bash   ef-share-session prepare|show|upload …      the plugin's own tool
//   Write  <prepared dir>/authored/{automations,chapters}.json   the two files
//          the publishing agent authors
//
// The 0.7–0.11 flow's `curl … session.jsonl=@<file>` upload is no longer approved
// here. It sends a transcript as it is on disk — not minimised — and names the
// file itself, so approving it meant approving the upload of ANY session's raw
// transcript without a prompt (verification 2026-11-16). A plugin's commands and
// hooks ship together: a session that runs this hook runs the current /share,
// which never issues that command. Someone who types it gets the normal
// permission prompt.
//
// HOW a command is recognised matters more than which commands are listed. The
// first version removed quoted spans with two regexes and then looked for shell
// operators in what was left; a quote character inside the other kind of quotes,
// or a backslash before a quote, made a chained command read as "no operators",
// and it was approved (review 2026-11-16, P-1). So the command is now TOKENISED
// the way the shell tokenises it, and the tokeniser gives up — returns null,
// which means "neutral" — at the first character the shell would interpret
// rather than copy: a backslash outside single quotes, a dollar sign, a
// backtick, any of ; & | < > ( ) { } * ? [ ] # ~ !, a newline. What is left is
// a list of literal words, and those are matched against the tool's own
// argument grammar (src/lib/cli-args.ts — the same function the tool parses
// with, so the two can never disagree on what a command line means).
//
// Not approved here, by design — these go through the normal permission flow:
//   - an upload that carries RESULTS (`--results` other than `none`): publishing
//     what a session made, beyond the session itself, is the person's own call;
//   - an upload over plain http or to a loopback address: the tool takes those
//     for local development, an injected command does not get them for free
//     (review 2026-11-20, A-7);
//   - `prepare --out <dir>`: only the tool's own temp directory is written
//     without a prompt;
//   - `prepare --result <path>`: it reports whether any file exists and what an
//     HTML file references (review 2026-11-20, A-8);
//   - a `--transcript` that is not THIS session's, or not an absolute path (the
//     hook and the tool would resolve a relative one against different
//     directories — review 2026-11-20, A-9);
//   - a `--dir`, or the directory of an authored Write, that is not the one
//     prepare made in its work directory for THIS session — private, the
//     person's own, no symbolic link on the way (src/lib/prepared-dir.ts;
//     review 2026-11-20, A-2 and A-3). "Publish this session" never silently
//     becomes "publish another one", or "write wherever a cloned repository's
//     symlink points".
//
// The hook fails closed: input it does not expect, or a check that throws, is
// no opinion — never allow.
//
// For `prepare` the hook also supplies the transcript path. The hook input
// carries this session's `transcript_path`, which is the one authoritative
// source — it does not depend on an env file being exported (desktop builds
// before 2.1.304 did not pass it to commands) or on a marker being in context
// (there is none when the model starts /share through the Skill tool).
import path from "node:path";
import { parseCommandArgs, flag, COMMAND_SPECS } from "../lib/cli-args.js";
import { isAutoApprovedUploadUrl } from "../lib/upload-url.js";
import { checkPreparedDir, lstatOrNull } from "../lib/prepared-dir.js";
const TOOL = "ef-share-session";
/** Characters a bare (unquoted) word may contain: nothing any shell expands. */
const BARE = /[\p{L}\p{M}\p{N}_\-./:=,@%+]/u;
const CONTROL = /[\n\r\0]/;
/**
 * The command without the spaces and tabs around it — and nothing more.
 * `String.prototype.trim` also removes a no-break space, U+2028, \v and \f,
 * which the shell does NOT treat as blanks: it keeps them as part of the last
 * word. Trimming them here made the hook approve a command line whose last
 * argument the shell would read differently (verification 2026-11-16, V-2).
 */
function stripBlanks(command) {
    return command.replace(/^[ \t]+|[ \t]+$/g, "");
}
/**
 * The command as the literal words a POSIX shell (bash, zsh) would pass to ONE
 * simple command — or null when anything in it is more than a literal word.
 *
 * Null means "not recognised", never "rejected": the caller stays neutral and
 * the normal permission flow decides.
 */
export function splitWords(command) {
    const src = stripBlanks(command);
    if (!src)
        return null;
    const words = [];
    let cur = "";
    let open = false; // a word is in progress (it may be the empty string "")
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === "'") {
            // single quotes: everything up to the next one is literal
            const end = src.indexOf("'", i + 1);
            if (end < 0)
                return null;
            const inner = src.slice(i + 1, end);
            if (CONTROL.test(inner))
                return null;
            cur += inner;
            open = true;
            i = end + 1;
        }
        else if (ch === '"') {
            // double quotes: a dollar sign, a backtick, a backslash and "!" still mean something
            let j = i + 1;
            let inner = "";
            for (;;) {
                if (j >= src.length)
                    return null;
                const c = src[j];
                if (c === '"')
                    break;
                if (c === "$" || c === "`" || c === "!" || CONTROL.test(c))
                    return null;
                if (c === "\\") {
                    // Inside double quotes a backslash is literal unless it precedes a
                    // dollar sign, a backtick, a double quote, a backslash or a newline.
                    // Only the plainly literal case is taken (a Windows path such as
                    // "C:\Users\me"); every other backslash is not ours to interpret.
                    const next = src[j + 1];
                    if (next === undefined || !/[A-Za-z0-9_.-]/.test(next))
                        return null;
                }
                inner += c;
                j++;
            }
            cur += inner;
            open = true;
            i = j + 1;
        }
        else if (ch === " " || ch === "\t") {
            if (open) {
                words.push(cur);
                cur = "";
                open = false;
            }
            i++;
        }
        else if (BARE.test(ch)) {
            // zsh expands a word that STARTS with "=" (=cmd becomes the command's path)
            if (ch === "=" && !open)
                return null;
            cur += ch;
            open = true;
            i++;
        }
        else {
            return null;
        }
    }
    if (open)
        words.push(cur);
    return words;
}
/**
 * The command as a call of the plugin's own tool, or null. Accepts the PATH form
 * (`ef-share-session …`) and the explicit form share.md falls back to
 * (`node "<plugin root>/bin/ef-share-session" …`) — the latter only for THIS
 * plugin's launcher, compared against CLAUDE_PLUGIN_ROOT when the hook has it.
 * The arguments must fit the tool's own grammar: an unknown option, a repeated
 * single-value option or a stray word is not a call of the tool.
 */
export function parseSessionToolCall(command, pluginRoot = process.env.CLAUDE_PLUGIN_ROOT) {
    if (!command || typeof command !== "string")
        return null;
    const words = splitWords(command);
    if (!words || words.length < 2)
        return null;
    let rest;
    if (words[0] === TOOL)
        rest = words.slice(1);
    else if (words[0] === "node" && words[1] && path.basename(words[1]) === TOOL) {
        if (!pluginRoot || !path.isAbsolute(words[1]))
            return null;
        if (path.resolve(words[1]) !== path.resolve(pluginRoot, "bin", TOOL))
            return null;
        rest = words.slice(2);
    }
    else
        return null;
    const subcommand = rest[0];
    if (!subcommand || !(subcommand in COMMAND_SPECS))
        return null;
    let parsed;
    try {
        parsed = parseCommandArgs(subcommand, rest.slice(1));
    }
    catch {
        return null;
    }
    return { subcommand, args: rest.slice(1), parsed };
}
function shQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
const samePath = (a, b) => path.resolve(a) === path.resolve(b);
const isAbsolutePath = (p) => typeof p === "string" && p !== "" && path.isAbsolute(p);
/**
 * True iff `dir` is the directory `ef-share-session prepare` made for THIS
 * session: in the tool's work directory with the name prepare gives, private
 * and the person's own, no symbolic link, holding prepare's manifest, which
 * names the transcript the hook input names (src/lib/prepared-dir.ts).
 * A directory prepared with `--out` elsewhere is the tool's to take, not the
 * hook's to approve.
 */
export function isPreparedDirFor(dir, transcriptPath) {
    if (!isAbsolutePath(dir) || !isAbsolutePath(transcriptPath))
        return false;
    return checkPreparedDir(dir, { transcriptPath }).ok;
}
/**
 * True iff `filePath` is one of the two files the publishing agent authors —
 * `authored/chapters.json` or `authored/automations.json` — in the directory
 * prepare made for THIS session (isPreparedDirFor), with `authored/` a real
 * folder and the file not there yet or a plain file of its own: no symbolic
 * link and no hard link a Write could be sent through (review 2026-11-20, A-2).
 */
export function isAuthoredFile(filePath, transcriptPath) {
    if (!isAbsolutePath(filePath))
        return false;
    const norm = path.normalize(filePath);
    if (norm !== filePath)
        return false; // no ../ or // tricks
    const name = path.basename(norm);
    if (name !== "automations.json" && name !== "chapters.json")
        return false;
    const authoredDir = path.dirname(norm);
    if (path.basename(authoredDir) !== "authored")
        return false;
    if (!isPreparedDirFor(path.dirname(authoredDir), transcriptPath))
        return false;
    const folder = lstatOrNull(authoredDir);
    if (!folder || folder.isSymbolicLink() || !folder.isDirectory())
        return false;
    const target = lstatOrNull(norm);
    return target === null || (target.isFile() && target.nlink === 1);
}
function allow(reason, updatedInput) {
    return {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: reason,
            ...(updatedInput ? { updatedInput } : {}),
        },
    };
}
const PREPARE_REASON = "ef-share: prepares this session's transcript for publishing — reads it, keeps the private records on this machine, " +
    "writes a prepared copy to its own temp directory. Nothing is sent.";
/** The decision for one tool call: an `allow`, or `{}` — no opinion, the normal permission flow decides. */
export function preToolUseOutput(payload, deps = {}) {
    try {
        return decide(payload, deps);
    }
    catch (err) {
        // fail closed: a check that cannot be completed approves nothing
        process.stderr.write(`ef-share pre-tool-use hook: no opinion (${err})\n`);
        return {};
    }
}
function decide(payload, deps) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return {};
    const input = payload.tool_input;
    if (!input || typeof input !== "object" || Array.isArray(input))
        return {};
    if (payload.transcript_path !== undefined && typeof payload.transcript_path !== "string")
        return {};
    const session = payload.transcript_path;
    if (payload.tool_name === "Write") {
        if (!isAuthoredFile(input.file_path, session))
            return {};
        return allow("ef-share: the publishing agent writes its chapter / automation titles into the directory ef-share prepared for this publish — no other file.");
    }
    if (payload.tool_name !== "Bash")
        return {};
    const command = input.command;
    if (typeof command !== "string")
        return {};
    const call = parseSessionToolCall(command);
    if (!call)
        return {};
    const isPrepared = deps.isPrepared ?? isPreparedDirFor;
    if (call.subcommand === "upload") {
        // Results are the person's call: no auto-approval for an upload that carries any.
        const results = flag(call.parsed, "results");
        if (results !== undefined && results !== "none")
            return {};
        const url = flag(call.parsed, "url");
        if (!url || !isAutoApprovedUploadUrl(url))
            return {};
        if (!isPrepared(flag(call.parsed, "dir"), session))
            return {};
        return allow("ef-share: authorized its own upload of this session to ElasticFlow Share (no result files). " +
            "The tool refuses any destination that is not an ElasticFlow Share endpoint.");
    }
    if (call.subcommand === "show") {
        if (!isPrepared(flag(call.parsed, "dir"), session))
            return {};
        return allow("ef-share: reads the candidates it prepared for this session. Nothing is written or sent.");
    }
    // prepare
    if (flag(call.parsed, "out") !== undefined)
        return {}; // writing where the person named is theirs to approve
    if (call.parsed.flags.has("result"))
        return {}; // looking at a file the person named is theirs to approve
    const transcript = flag(call.parsed, "transcript");
    if (transcript !== undefined) {
        // absolute only: the hook would resolve a relative path against its own directory, the tool against the shell's
        if (!path.isAbsolute(transcript) || !isAbsolutePath(session) || !samePath(transcript, session))
            return {};
        return allow(PREPARE_REASON);
    }
    if (session !== undefined) {
        if (!isAbsolutePath(session))
            return {};
        return allow(PREPARE_REASON, { ...input, command: `${stripBlanks(command)} --transcript ${shQuote(session)}` });
    }
    return allow("ef-share: prepares this session's transcript for publishing (the path comes from the session's own environment). Nothing is sent.");
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
