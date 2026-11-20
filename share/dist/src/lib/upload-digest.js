// packages/ef-share-plugin/src/lib/upload-digest.ts
//
// What `ef-share-session upload` prints.
//
// The publishing agent decides from this output whether to publish: which
// preview pictures to look at (`sent.results[].preview_file`), whether a result
// holds something that looks like a secret (`response.resultWarnings`), whether
// the server staged everything (`staged`), what to relay (`notes`). Claude Code
// shows the agent the first 30,000 characters of a command's output and saves
// the rest to a file. The server's reply carries one redaction candidate per
// place that may hold sensitive data — 160–350 of them on real sessions, about
// 90 KB printed — and the fields above used to come after that list (review B-1,
// 2026-11-20: `sent` started at character 90,881 of 91,405).
//
// So the output is ordered and bounded:
//
//   1. everything the agent decides on, first;
//   2. the server's reply without the candidate list;
//   3. the candidates of severity "secret", one per line, exactly as the server
//      returned them (a chosen one goes into share_publish's `redactions` as it
//      is) — as many as fit; the counts say how many there are in all;
//   4. the whole reply and the whole candidate list are written into the
//      prepared directory, private like everything else in it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
/** What Claude Code shows the agent of one command's output (measured on 2.1.281). */
export const BASH_OUTPUT_SHOWN_CHARS = 30_000;
/** The candidates listed inline take at most this much … */
const INLINE_CANDIDATES_CHARS = 18_000;
/** … and never so much that the whole output comes within this of the limit above. */
const OUTPUT_MARGIN_CHARS = 1_000;
/** A reply that is not JSON (a proxy's error page) is printed up to this length. */
const TEXT_REPLY_CHARS = 2_000;
export const RESPONSE_FILE = "upload-response.json";
export const CANDIDATES_FILE = "redaction-candidates.jsonl";
function isSecret(c) {
    return c["severity"] === "secret";
}
/**
 * Writes a file of the tool's own into the prepared directory. Whatever stands at
 * that name is replaced, never written THROUGH: a symbolic or hard link planted
 * there would otherwise put the server's reply into another file (review round 2,
 * A2-6). The new file is created exclusively and private.
 */
function writePrivate(file, text) {
    let there = null;
    try {
        there = fs.lstatSync(file);
    }
    catch { /* not there */ }
    if (there?.isDirectory())
        throw new Error(`${path.basename(file)} is a directory`);
    if (there)
        fs.unlinkSync(file); // removes the name — a link's target is left alone
    fs.writeFileSync(file, text, { mode: 0o600, flag: "wx" });
}
/**
 * The text `upload` prints for an outcome: one JSON object, the decision fields
 * first, each listed candidate on a line of its own. Writes the whole reply and
 * the whole candidate list into `dir`; when that fails the output says so and
 * still carries everything that fits.
 */
export function digestUpload(dir, outcome) {
    const reply = outcome.response;
    const isObject = !!reply && typeof reply === "object" && !Array.isArray(reply);
    const { redactionCandidates, ...rest } = (isObject ? reply : {});
    const all = Array.isArray(redactionCandidates)
        ? redactionCandidates.filter((c) => !!c && typeof c === "object" && !Array.isArray(c))
        : [];
    // secret first; inside each group the server's own order
    const ordered = [...all.filter(isSecret), ...all.filter((c) => !isSecret(c))];
    const notes = [...outcome.notes];
    let responseFile = path.join(dir, RESPONSE_FILE);
    let candidatesFile = path.join(dir, CANDIDATES_FILE);
    try {
        writePrivate(responseFile, typeof reply === "string" ? reply : JSON.stringify(reply, null, 1));
        writePrivate(candidatesFile, ordered.map((c) => JSON.stringify(c)).join("\n") + (ordered.length > 0 ? "\n" : ""));
    }
    catch (e) {
        responseFile = null;
        candidatesFile = null;
        notes.push(`the server's full reply could not be saved in ${dir} (${e.message}): only what is printed here is available`);
    }
    const bySeverity = {};
    for (const c of all) {
        const s = typeof c["severity"] === "string" ? c["severity"] : "unknown";
        bySeverity[s] = (bySeverity[s] ?? 0) + 1;
    }
    // The secret-severity candidates, in order, each printed on one line — as many as
    // their own allowance takes.
    const lines = [];
    let used = 0;
    for (const c of ordered) {
        if (!isSecret(c))
            break;
        const line = JSON.stringify(c);
        if (used + line.length > INLINE_CANDIDATES_CHARS)
            break;
        lines.push(line);
        used += line.length + 4;
    }
    const omitted = rest["redactionCandidatesOmitted"];
    // a marker no reply can contain, so a candidate's own text is never taken for one
    const nonce = crypto.randomUUID();
    const mark = (i) => `@@${nonce}-${i}@@`;
    /** The output with the first `n` candidates listed. */
    const render = (n) => {
        const printed = {
            ok: outcome.ok,
            status: outcome.status,
            staged: outcome.staged,
            notes,
            sent: outcome.sent,
            response: isObject ? rest : typeof reply === "string" ? reply.slice(0, TEXT_REPLY_CHARS) : reply,
            response_file: responseFile,
            redaction: {
                total: all.length,
                by_severity: bySeverity,
                in_subagent_files: all.filter((c) => typeof c["file"] === "string").length,
                ...(typeof omitted === "number" ? { left_out_by_the_server: omitted } : {}),
                listed_here: n,
                not_listed_here: all.length - n,
                all_candidates_file: candidatesFile,
                candidates: lines.slice(0, n).map((_, i) => mark(i)),
            },
        };
        // Pretty-print the object, then put each candidate on its own line: compact rows
        // are a quarter of the size of indented ones, and a row is what gets copied.
        let text = JSON.stringify(printed, null, 1);
        for (let i = 0; i < n; i++)
            text = text.replace(`"${mark(i)}"`, () => lines[i]);
        return text;
    };
    // The list takes what the rest of the output leaves: many results, each with a
    // long path, and many warnings about them come first and are never given up for it
    // (review round 2, B2-2). `listed_here` is always what is printed.
    let n = lines.length;
    let text = render(n);
    while (n > 0 && text.length > BASH_OUTPUT_SHOWN_CHARS - OUTPUT_MARGIN_CHARS) {
        const over = text.length - (BASH_OUTPUT_SHOWN_CHARS - OUTPUT_MARGIN_CHARS);
        let drop = 0;
        for (let freed = 0; drop < n && freed < over; drop++)
            freed += lines[n - 1 - drop].length + 4;
        n -= Math.max(1, drop);
        text = render(n);
    }
    return text;
}
