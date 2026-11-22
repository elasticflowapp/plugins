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
import crypto from "node:crypto";
import { UsageError } from "./cli-args.js";
/**
 * The name prepare gives a directory it makes in the work directory:
 * ef-share-<8 hex of the transcript path's sha256>-<the 6 characters mkdtemp adds>.
 * 0.12.0 wrote six random hex digits there; they fit the same pattern.
 */
export const PREPARED_NAME = /^ef-share-[0-9a-f]{8}-[A-Za-z0-9]{6}$/;
/** Where prepare makes its directories when no --out is given: EF_SHARE_WORK_DIR, else the system's temp folder (which TMPDIR names). */
export function preparedWorkDir(env = process.env) {
    return env["EF_SHARE_WORK_DIR"] ?? os.tmpdir();
}
/**
 * The account's home folder as the system records it (the user database; on
 * Windows the profile folder) — not what the environment says it is. Empty when
 * the system does not say: then no folder counts as the home folder.
 */
export function accountHome() {
    try {
        return os.userInfo().homedir || "";
    }
    catch {
        return "";
    }
}
/**
 * Why the work directory is not the tool's own place for this session — or null.
 *
 * The hook approves `prepare`, `show`, `upload` and the two authored Writes
 * without a prompt because they happen in a directory only the tool writes to.
 * A work directory that is one of the session's project directories, or lies
 * below one, is not that: a repository's settings can name it (EF_SHARE_WORK_DIR,
 * or TMPDIR, which names the temp folder), and the session writes there without a
 * prompt (release review 2026-11-20, note 10).
 *
 * "Is" and "below" are asked of the directories themselves, not of their names:
 * the work directory's real parents, one by one up to the root, are compared with
 * each project directory by device and inode. The same directory has many names
 * — in another letter case on a file system that does not tell them apart,
 * through a link, through /System/Volumes/Data on macOS — and a comparison of
 * path text approved every one of them but the first (review of 0.12.1, R1-1;
 * R1-2 for TMPDIR). The climb starts from the true path of the deepest part of
 * the name that exists: climbing the name as written passed a link that stands
 * outside the project and leads below its root (R2-1). A work directory whose
 * name the hook would have to interpret — not absolute, or with a `..` in it — is
 * refused outright.
 *
 * One layout is the machine's own and not a project naming a place: when no
 * variable of the tool's names the work directory and the session is in the home
 * folder or above it, the temp folder lies below "the project" by itself —
 * Windows keeps it under the home folder, and `/` is above everything. Such a
 * project directory is not judged against the temp folder (R2-3: judged, every
 * step of /share asked for permission there). EF_SHARE_WORK_DIR is always judged.
 * The home folder is the one the system records for the account (accountHome),
 * never $HOME: whoever can set TMPDIR can set that too. `home` is injected in tests.
 */
export function workDirInsideProject(projectDirs, env = process.env, home = accountHome()) {
    const named = env["EF_SHARE_WORK_DIR"];
    const workRaw = preparedWorkDir(env);
    const what = named ? `EF_SHARE_WORK_DIR (${workRaw})` : `the temp folder (${workRaw})`;
    if (!path.isAbsolute(workRaw) || workRaw.split(/[\\/]/).includes(".."))
        return `${what} is not a plain absolute path`;
    const identity = (p) => {
        try {
            const st = fs.statSync(p, { bigint: true });
            return st.isDirectory() ? `${st.dev}:${st.ino}` : null;
        }
        catch {
            return null;
        }
    };
    /** the path with every link in it followed — as far as the path exists, the rest as written */
    const truePath = (p) => {
        let existing = path.resolve(p);
        const rest = [];
        for (;;) {
            try {
                fs.statSync(existing);
                break;
            }
            catch { /* not there: look at its parent */ }
            const up = path.dirname(existing);
            if (up === existing)
                break;
            rest.unshift(path.basename(existing));
            existing = up;
        }
        let real;
        try {
            real = fs.realpathSync.native(existing);
        }
        catch {
            try {
                real = fs.realpathSync(existing);
            }
            catch {
                real = existing;
            }
        }
        return path.join(real, ...rest);
    };
    /** `start` and every directory above it, each as what it is */
    const upFrom = (start) => {
        const ids = new Set();
        for (let dir = start;; dir = path.dirname(dir)) {
            const id = identity(dir);
            if (id !== null)
                ids.add(id);
            if (dir === path.dirname(dir))
                break;
        }
        return ids;
    };
    // the home folder and what is above it: the machine's own layout, when the temp folder is the work directory
    const ownLayout = named || !home || !path.isAbsolute(home) ? new Set() : upFrom(truePath(home));
    const projects = projectDirs
        .filter((p) => !!p && path.isAbsolute(p))
        .map((p) => ({ id: identity(p), text: truePath(p) }))
        .filter((p) => !(p.id !== null && ownLayout.has(p.id)));
    if (projects.length === 0)
        return null;
    const inside = `${what} points inside this session's project directory`;
    const work = truePath(workRaw);
    // by name, for a project directory that is not there to be looked at
    for (const p of projects)
        if (work === p.text || work.startsWith(p.text.endsWith(path.sep) ? p.text : p.text + path.sep))
            return inside;
    // by what each directory is: the work directory's real parents, and its name's as written
    const above = new Set([...upFrom(work), ...upFrom(path.resolve(workRaw))]);
    return projects.some((p) => p.id !== null && above.has(p.id)) ? inside : null;
}
/**
 * Why `dir` is not a directory of the person's own that nobody else can open — or
 * null when it is. Read off the directory as it stands (lstat): a symbolic link is
 * not one, and on POSIX it is owned by the user the tool runs as and closed to
 * group and others.
 */
function ownPrivateDirProblem(dir, opts = {}) {
    const st = lstatOrNull(dir);
    if (!st)
        return "it does not exist";
    if (st.isSymbolicLink())
        return "it is a symbolic link";
    if (!st.isDirectory())
        return "it is not a directory";
    if ((opts.platform ?? process.platform) !== "win32") {
        const uid = opts.uid !== undefined ? opts.uid : typeof process.getuid === "function" ? process.getuid() : null;
        if (uid !== null && st.uid !== uid)
            return "it belongs to another user";
        if ((st.mode & 0o077) !== 0)
            return `other users can open it (mode 0${(st.mode & 0o777).toString(8)}; prepare makes it 0700)`;
    }
    return null;
}
/**
 * `dir` must be the person's own directory, closed to everyone else — or the copy
 * of a session is not written into it. The judge is the directory as it is after
 * prepare tried to close it, not whether the chmod call raised: in a shared temp
 * folder a directory someone else made beforehand takes the files and keeps its
 * own owner and mode (release review 2026-11-20, note 7).
 */
export function assertOwnPrivateDir(dir, opts = {}) {
    const problem = ownPrivateDirProblem(dir, opts);
    if (problem)
        throw new UsageError(`${dir}: ${problem} — not writing a copy of the session into it`);
}
/**
 * A new directory for one prepare run, in the work directory: made here and now by
 * mkdtemp — it did not exist, it is the caller's, it is 0700 — under the name
 * PREPARED_NAME describes. Never a name computed first and created after.
 */
export function newPreparedDir(workDir, transcriptPath) {
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 }); // a work directory that is not there yet is made closed, as before
    const sid = crypto.createHash("sha256").update(path.resolve(transcriptPath)).digest("hex").slice(0, 8);
    const dir = fs.mkdtempSync(path.join(workDir, `ef-share-${sid}-`));
    assertOwnPrivateDir(dir);
    return dir;
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
    const problem = ownPrivateDirProblem(dir, opts);
    if (problem)
        return no(problem);
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
    // The work directory is the tool's own place only while it is outside the session's project.
    if (opts.projectDirs) {
        const why = workDirInsideProject(opts.projectDirs, opts.env, opts.home);
        if (why)
            return no(why);
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
