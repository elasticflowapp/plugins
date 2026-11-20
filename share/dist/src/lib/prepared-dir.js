// packages/ef-share-plugin/src/lib/prepared-dir.ts
//
// Is this a directory `ef-share-session prepare` made? ONE test, asked by two
// programs:
//
//   - the PreToolUse hook, before it approves `show`, `upload` or the Write of
//     an authored file without a prompt — and there the directory must also be
//     in the tool's work directory and prepared from THIS session's transcript;
//   - the tool itself, before `show` or `upload` reads anything from `--dir`.
//
// Review 2026-11-20 (A-2, A-3): the hook approved a Write into any directory
// holding files NAMED manifest.json and session.jsonl, through a symbolic link
// too, and approved show / upload for any directory whose manifest named this
// session; upload then joined the manifest's sub-agent ids into paths. A cloned
// repository could ship such a directory.
//
// What prepare makes, and so what is accepted: a real directory (not a symbolic
// link) owned by the person running the tool and closed to everyone else (0700
// — POSIX only), holding prepare's manifest as a regular file and, when there,
// `authored/` as a real directory; and EITHER a direct child of the work
// directory with the name prepare gives, OR (the tool only, for `prepare --out`)
// the directory its own manifest records as prepare's output.
//
// The hook runs on every Bash and Write call of every session: this module
// imports nothing but node built-ins and the argument grammar's error class.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "./cli-args.js";
/** The name prepare gives a directory it makes in the work directory: ef-share-<8 hex of the transcript path's sha256>-<6 random hex>. */
export const PREPARED_NAME = /^ef-share-[0-9a-f]{8}-[0-9a-f]{6}$/;
/** Where prepare makes its directories when no --out is given. */
export function preparedWorkDir(env = process.env) {
    return env["EF_SHARE_WORK_DIR"] ?? os.tmpdir();
}
/** The folders of a prepared directory. */
const OWN_FOLDERS = ["authored", "extract", "final", "previews", "subagents"];
/**
 * A JSON file of a prepared directory — a list prepare extracted, a title file the
 * publishing agent wrote — read only when it is a plain file of its own. Through a
 * symbolic or a hard link it would be another file's content that is shown or
 * sent (review round 2, A2-6). Null when it is not there or is not JSON.
 */
export function readPreparedJson(file) {
    const st = lstatOrNull(file);
    if (!st)
        return null;
    if (!st.isFile() || st.nlink > 1) {
        throw new UsageError(`${file} is a link to another file or not a regular file — a prepared directory holds only files prepare and the publishing agent wrote; run "ef-share-session prepare" again`);
    }
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
    catch {
        return null;
    }
}
/** A manifest is read only up to this size; prepare's is a few KB to a few hundred KB. */
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
/** lstat, with "not there" as null. Any other failure is thrown — the caller refuses. */
export function lstatOrNull(p) {
    try {
        return fs.lstatSync(p);
    }
    catch (e) {
        if (e.code === "ENOENT")
            return null;
        throw e;
    }
}
const no = (reason) => ({ ok: false, reason });
/**
 * Whether `dir` is a directory prepare made, and why not. Never throws: a check
 * that cannot be completed is a refusal.
 */
export function checkPreparedDir(dir, opts = {}) {
    try {
        return check(dir, opts);
    }
    catch (e) {
        return no(`it could not be checked (${e.message})`);
    }
}
function check(dir, opts) {
    if (typeof dir !== "string" || dir === "")
        return no("no directory was given");
    if (!path.isAbsolute(dir))
        return no("the path is not absolute");
    const st = lstatOrNull(dir);
    if (!st)
        return no("it does not exist");
    if (st.isSymbolicLink())
        return no("it is a symbolic link");
    if (!st.isDirectory())
        return no("it is not a directory");
    if ((opts.platform ?? process.platform) !== "win32") {
        const uid = opts.uid !== undefined ? opts.uid : typeof process.getuid === "function" ? process.getuid() : null;
        if (uid !== null && st.uid !== uid)
            return no("it belongs to another user");
        if ((st.mode & 0o077) !== 0)
            return no(`other users can open it (mode 0${(st.mode & 0o777).toString(8)}; prepare makes it 0700)`);
    }
    const real = fs.realpathSync(dir);
    // Where it is, first: it costs two path lookups, and the hook needs nothing else of a directory
    // outside the work directory — not even to read the manifest a cloned repository put there.
    const workRaw = preparedWorkDir(opts.env);
    let work = null;
    if (path.isAbsolute(workRaw)) {
        try {
            work = fs.realpathSync(workRaw);
        }
        catch {
            work = null;
        }
    }
    const inWork = work !== null && path.dirname(real) === work && PREPARED_NAME.test(path.basename(real));
    const notHere = opts.acceptOwnOut
        ? `it is not in ef-share's work directory (${workRaw}) and its manifest does not record it as prepare's output`
        : `it is not a directory prepare made in ef-share's work directory (${workRaw})`;
    if (!inWork && !opts.acceptOwnOut)
        return no(notHere);
    const manifestFile = path.join(real, "manifest.json");
    const mst = lstatOrNull(manifestFile);
    if (!mst)
        return no("it has no manifest.json");
    if (!mst.isFile())
        return no("its manifest.json is a symbolic link or not a regular file");
    if (mst.nlink > 1)
        return no("its manifest.json is a hard link to another file");
    if (mst.size > MANIFEST_MAX_BYTES)
        return no("its manifest.json is larger than any prepare writes");
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    }
    catch {
        manifest = null;
    }
    const m = manifest;
    if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.prepare_version !== "number" ||
        !m.transcript || typeof m.transcript !== "object" || typeof m.transcript.source !== "string") {
        return no("its manifest.json is not one prepare wrote");
    }
    if (opts.transcriptPath !== undefined) {
        if (!path.isAbsolute(opts.transcriptPath) || path.resolve(m.transcript.source) !== path.resolve(opts.transcriptPath)) {
            return no("it was prepared from another session's transcript");
        }
    }
    // Every folder prepare, the publishing agent or upload writes into: a link in its place
    // would have files read from, or written to, somewhere else (review round 3, R3-3).
    for (const name of OWN_FOLDERS) {
        const st = lstatOrNull(path.join(real, name));
        if (st && (st.isSymbolicLink() || !st.isDirectory()))
            return no(`its ${name}/ folder is a symbolic link or not a folder`);
    }
    if (inWork)
        return { ok: true, dir: real, manifest: m, where: "work" };
    // `prepare --out <dir>` (the tool only): the directory its own manifest records as prepare's output
    if (opts.acceptOwnOut && typeof m.dir === "string" && path.isAbsolute(m.dir)) {
        let recorded;
        try {
            recorded = fs.realpathSync(m.dir);
        }
        catch {
            recorded = null;
        }
        if (recorded === real)
            return { ok: true, dir: real, manifest: m, where: "out" };
    }
    return no(notHere);
}
/** The words every refusal of a `--dir` ends with. */
export function notPreparedMessage(dir, reason) {
    return `${dir} is not a prepared directory: ${reason} — run "ef-share-session prepare" and use the directory it prints`;
}
/**
 * The tool's side: `dir` (relative to the working directory, as a person may
 * type it) must be a directory prepare made — in the work directory, or with
 * --out where its manifest records it. Exit code 2 otherwise, naming why.
 */
export function requirePreparedDir(dir, opts = {}) {
    const verdict = checkPreparedDir(path.resolve(dir), { ...opts, acceptOwnOut: true });
    if (!verdict.ok)
        throw new UsageError(notPreparedMessage(dir, verdict.reason));
    return verdict;
}
