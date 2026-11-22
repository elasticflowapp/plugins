// packages/ef-share-plugin/src/lib/results.ts
//
// "Results" are the things a session MADE, as opposed to the conversation that
// made them. v1 covers the interactive kind: an HTML page (and the local files
// it loads), so a reader can run the result, not only read how it came about.
//
// This module only FINDS candidates and says exactly which files each one would
// publish. Nothing here uploads anything: a result leaves the machine only after
// the person has been shown the list and said yes (commands/share.md).
//
// A candidate is an .html/.htm file that the session wrote or edited (Write /
// Edit / MultiEdit in the main transcript or any sub-agent's) or handed to the
// person (SendUserFile), or that the person named (`--result`), and that still
// exists on disk. Its assets are found by following local references — never by
// publishing the folder around it.
//
// Every file is checked against the rules the server applies (result-types.ts)
// while it is still only a candidate, so what is listed as "will be published"
// is what the server will take.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { records } from "./transcript.js";
import { RESULT_MIME, ENTRY_EXT, unpublishablePath, unpublishableEntry } from "./result-types.js";
export const RESULT_LIMITS = {
    maxEntryBytes: 8 * 1024 * 1024,
    maxAssetBytes: 8 * 1024 * 1024,
    maxTotalBytes: 20 * 1024 * 1024,
    maxAssets: 80,
    maxDepth: 3,
    /** pages the session touched that are listed; a page the person named is always listed on top of these */
    maxCandidates: 12,
};
/** Asset types a page can load. Anything else a reference points at stays on disk. */
const ASSET_EXT = new Set(Object.keys(RESULT_MIME).filter((ext) => !ENTRY_EXT.has(ext)));
const WRITE_TOOLS = new Set(["Write"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit"]);
function isEntry(p) { return ENTRY_EXT.has(path.extname(p).toLowerCase()); }
/** Every .html the transcript wrote, edited or sent to the person, keyed by absolute path. */
export function collectTouchedPages(jsonl, bySubagent, into = new Map()) {
    for (const rec of records(jsonl)) {
        if (rec["type"] !== "assistant")
            continue;
        const content = (rec["message"] ?? {})["content"];
        if (!Array.isArray(content))
            continue;
        const cwd = typeof rec["cwd"] === "string" ? rec["cwd"] : null;
        const ts = typeof rec["timestamp"] === "string" ? rec["timestamp"] : null;
        for (const part of content) {
            if (!part || typeof part !== "object" || part["type"] !== "tool_use")
                continue;
            const name = String(part["name"] ?? "");
            const input = (part["input"] ?? {});
            const paths = [];
            let kind = null;
            if (WRITE_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
                if (typeof input["file_path"] === "string")
                    paths.push(input["file_path"]);
                kind = WRITE_TOOLS.has(name) ? "write" : "edit";
            }
            else if (name === "SendUserFile") {
                if (Array.isArray(input["files"]))
                    for (const f of input["files"])
                        if (typeof f === "string")
                            paths.push(f);
                kind = "sent";
            }
            if (kind === null)
                continue;
            for (const raw of paths) {
                if (!isEntry(raw))
                    continue;
                const abs = path.isAbsolute(raw) ? path.normalize(raw) : cwd ? path.resolve(cwd, raw) : null;
                if (!abs)
                    continue;
                const t = into.get(abs) ?? { path: abs, writes: 0, edits: 0, sent: false, last: null, bySubagent };
                if (kind === "write")
                    t.writes++;
                else if (kind === "edit")
                    t.edits++;
                else
                    t.sent = true;
                if (ts && (t.last === null || ts > t.last))
                    t.last = ts;
                if (!bySubagent)
                    t.bySubagent = false;
                into.set(abs, t);
            }
        }
    }
    return into;
}
// ─── local reference discovery ───────────────────────────────────────────────
const REMOTE = /^(?:https?:)?\/\//i;
const NOT_A_FILE = /^(?:data:|blob:|javascript:|mailto:|tel:|about:|#)/i;
// The markup entities, and the Latin-1 names (&nbsp; … &yuml; are U+00A0 … U+00FF,
// in this order) — the ones a file name in a European language is written with.
// HTML defines some 2,200 more; a reference that still holds one after decoding
// is reported as such, not as a missing file.
const LATIN1 = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
    "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
    "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
const NAMED_ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
LATIN1.split(" ").forEach((name, i) => { NAMED_ENTITIES[name] = String.fromCodePoint(0xa0 + i); });
const UNDECODED_ENTITY = /&[A-Za-z][A-Za-z0-9]{1,30};/;
/** An HTML attribute value as the browser reads it: `a&amp;b.png` names the file `a&b.png`. */
export function decodeEntities(value) {
    if (!value.includes("&"))
        return value;
    return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,30}));/g, (whole, dec, hex, name) => {
        if (dec !== undefined || hex !== undefined) {
            const cp = dec !== undefined ? Number(dec) : parseInt(hex, 16);
            try {
                return String.fromCodePoint(cp);
            }
            catch {
                return whole;
            }
        }
        // entity names are case-sensitive (&Eacute; is É, &eacute; is é)
        return NAMED_ENTITIES[String(name)] ?? whole;
    });
}
/**
 * True when publishing `key` beside the names already `taken` would collide on
 * the server, which compares names case-insensitively and NFC-normalised and
 * refuses a result in which one path is both a file and a folder of another.
 * Keys are `rel.normalize("NFC").toLowerCase()`.
 */
export function nameCollides(taken, key) {
    if (taken.has(key))
        return true;
    for (const other of taken)
        if (other.startsWith(key + "/") || key.startsWith(other + "/"))
            return true;
    return false;
}
function refsInHtml(html) {
    const out = [];
    const attr = (v) => decodeEntities(v ?? "");
    // src / poster / data on any element; href only on <link> (an <a href> is navigation, not a dependency)
    for (const m of html.matchAll(/\b(?:src|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
        out.push(attr(m[1] ?? m[2]));
    for (const m of html.matchAll(/<link\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
        out.push(attr(m[1] ?? m[2]));
    for (const m of html.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        for (const cand of attr(m[1] ?? m[2]).split(","))
            out.push(cand.trim().split(/\s+/)[0] ?? "");
    }
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
        out.push(...refsInCss(m[1]));
    for (const m of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi))
        out.push(...refsInJs(m[1]));
    return out;
}
function refsInCss(css) {
    const out = [];
    for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi))
        out.push(m[1] ?? m[2] ?? m[3] ?? "");
    for (const m of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi))
        out.push(m[1] ?? m[2] ?? "");
    return out;
}
/**
 * A script names its dependencies in string literals (import, fetch, new URL,
 * a loader's .load). Any literal that looks like a relative file of a
 * publishable type is a candidate; whether it is published is decided by the
 * same checks as every other reference — it must exist, inside the page's folder.
 */
function refsInJs(js) {
    const out = [];
    for (const m of js.matchAll(/(["'`])((?:\.{0,2}\/)?[\w@%+~.\-/]{1,200}\.[A-Za-z0-9]{1,5})(?:[?#][^"'`]*)?\1/g)) {
        if (ASSET_EXT.has(path.extname(m[2]).toLowerCase()))
            out.push(m[2]);
    }
    return out;
}
function inside(root, p) {
    const rel = path.relative(root, p);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function readBytes(p) {
    try {
        return fs.readFileSync(p);
    }
    catch {
        return null;
    }
}
export const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const nothing = (blocked, bytes = 0) => ({ bytes, sha256: null, assets: [], skipped: [], remote_hosts: [], total_bytes: bytes, blocked });
export function describeResult(entryPath) {
    const L = RESULT_LIMITS;
    let entryReal;
    let entryStat;
    try {
        entryReal = fs.realpathSync(entryPath);
        entryStat = fs.statSync(entryReal);
    }
    catch {
        return nothing("the file no longer exists");
    }
    if (!entryStat.isFile())
        return nothing("not a regular file");
    // The entry is published under its own file name: it has to be a name the server stores.
    const entryProblem = unpublishableEntry(path.basename(entryPath));
    if (entryProblem)
        return nothing(entryProblem, entryStat.size);
    if (entryStat.size > L.maxEntryBytes)
        return nothing(`the page is larger than ${Math.round(L.maxEntryBytes / 1048576)} MB`, entryStat.size);
    // Each listed file is read ONCE here: its size, its digest and the references in it come
    // from the same bytes. The digest is what "unchanged since listed" means at upload — a
    // size alone is the same for any other content of that length.
    const entryData = readBytes(entryReal);
    if (entryData === null)
        return nothing("the file could not be read", entryStat.size);
    if (entryData.length > L.maxEntryBytes)
        return nothing(`the page is larger than ${Math.round(L.maxEntryBytes / 1048576)} MB`, entryData.length);
    const root = path.dirname(entryReal);
    const assets = new Map();
    const skipped = new Map();
    const hosts = new Set();
    let total = entryData.length;
    const nameKey = (rel) => rel.normalize("NFC").toLowerCase();
    const taken = new Set([nameKey(path.basename(entryPath))]);
    const queue = [{ file: entryReal, depth: 0, text: entryData.toString("utf-8") }];
    const visited = new Set([entryReal]);
    while (queue.length > 0) {
        const { file, depth, text } = queue.shift();
        const ext = path.extname(file).toLowerCase();
        const refs = ENTRY_EXT.has(ext) ? refsInHtml(text) : ext === ".css" ? refsInCss(text) : (ext === ".js" || ext === ".mjs") ? refsInJs(text) : [];
        for (const raw of refs) {
            const ref = raw.trim();
            if (!ref || NOT_A_FILE.test(ref))
                continue;
            if (REMOTE.test(ref)) {
                try {
                    hosts.add(new URL(ref.startsWith("//") ? `https:${ref}` : ref).host);
                }
                catch { /* not a url */ }
                continue;
            }
            const clean = ref.split(/[?#]/)[0];
            if (!clean)
                continue;
            let decoded;
            try {
                decoded = decodeURIComponent(clean);
            }
            catch {
                decoded = clean;
            }
            if (decoded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(decoded)) {
                skipped.set(ref, "absolute path — only files beside the page are published");
                continue;
            }
            const target = path.resolve(path.dirname(file), decoded);
            let real;
            try {
                real = fs.realpathSync(target);
            }
            catch {
                const entity = UNDECODED_ENTITY.exec(ref);
                skipped.set(ref, entity ? `not found on disk as written — "${entity[0]}" is an HTML entity this tool does not decode; write the character itself` : "not found on disk");
                continue;
            }
            if (visited.has(real))
                continue;
            if (!inside(root, real)) {
                skipped.set(ref, "outside the page's folder");
                continue;
            }
            const rel = path.relative(root, real).split(path.sep).join("/");
            const problem = unpublishablePath(rel);
            if (problem) {
                skipped.set(ref, problem);
                continue;
            }
            const aext = path.extname(real).toLowerCase();
            if (!ASSET_EXT.has(aext)) {
                skipped.set(ref, "another page — a result is one page and the files it loads");
                continue;
            }
            let st;
            try {
                st = fs.statSync(real);
            }
            catch {
                skipped.set(ref, "not found on disk");
                continue;
            }
            if (!st.isFile())
                continue;
            if (st.size > L.maxAssetBytes) {
                skipped.set(ref, `larger than ${Math.round(L.maxAssetBytes / 1048576)} MB`);
                continue;
            }
            if (assets.size >= L.maxAssets) {
                skipped.set(ref, `more than ${L.maxAssets} files`);
                continue;
            }
            if (total + st.size > L.maxTotalBytes) {
                skipped.set(ref, `the result would exceed ${Math.round(L.maxTotalBytes / 1048576)} MB`);
                continue;
            }
            const key = nameKey(rel);
            if (nameCollides(taken, key)) {
                skipped.set(ref, "its name differs from another published file only by letter case, or is also a folder");
                continue;
            }
            const data = readBytes(real);
            if (data === null) {
                skipped.set(ref, "could not be read");
                continue;
            }
            // the file grew between the look at its size and the read: judged by what was read
            if (data.length > L.maxAssetBytes) {
                skipped.set(ref, `larger than ${Math.round(L.maxAssetBytes / 1048576)} MB`);
                continue;
            }
            if (total + data.length > L.maxTotalBytes) {
                skipped.set(ref, `the result would exceed ${Math.round(L.maxTotalBytes / 1048576)} MB`);
                continue;
            }
            taken.add(key);
            visited.add(real);
            assets.set(real, { rel, abs: real, bytes: data.length, sha256: sha256Hex(data) });
            total += data.length;
            if (depth + 1 < L.maxDepth && (aext === ".css" || aext === ".js" || aext === ".mjs"))
                queue.push({ file: real, depth: depth + 1, text: data.toString("utf-8") });
        }
    }
    return {
        bytes: entryData.length,
        sha256: sha256Hex(entryData),
        assets: [...assets.values()].sort((a, b) => a.rel.localeCompare(b.rel)),
        skipped: [...skipped.entries()].map(([ref, reason]) => ({ ref: ref.slice(0, 200), reason })).slice(0, 40),
        remote_hosts: [...hosts].sort().slice(0, 20),
        total_bytes: total,
        blocked: null,
    };
}
/**
 * Result candidates of a session: the pages the person named first, then the
 * pages the session touched, most recently touched first.
 *
 * `transcripts` is the main transcript followed by each sub-agent's. `notes`
 * collects what the caller must tell the person: a named file that is not
 * there, touched pages that did not fit the list.
 */
export function findResultCandidates(transcripts, extraPaths = [], notes = []) {
    const touched = new Map();
    for (const t of transcripts)
        collectTouchedPages(t.jsonl, t.subagent, touched);
    const isFile = (p) => { try {
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    } };
    // A page the person named is why they re-ran prepare: it is listed whatever
    // else there is, and a path that does not lead to a file is said out loud.
    const named = [];
    const namedPaths = new Set();
    for (const p of extraPaths) {
        const abs = path.resolve(p);
        if (namedPaths.has(abs))
            continue;
        if (!isFile(abs)) {
            notes.push(`--result ${p}: there is no such file — it is not listed`);
            continue;
        }
        namedPaths.add(abs);
        named.push(touched.get(abs) ?? { path: abs, writes: 0, edits: 0, sent: false, last: null, bySubagent: false });
    }
    const rest = [...touched.values()].filter((t) => !namedPaths.has(t.path) && isFile(t.path));
    rest.sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "") || a.path.localeCompare(b.path));
    const listed = rest.slice(0, RESULT_LIMITS.maxCandidates);
    if (rest.length > listed.length) {
        notes.push(`${rest.length - listed.length} more page(s) the session touched are not listed (the ${RESULT_LIMITS.maxCandidates} most recent are) — name one with --result "<path>" to list it`);
    }
    return [...named, ...listed].map((t, i) => ({
        id: i + 1,
        entry: path.basename(t.path),
        path: t.path,
        last_touched_at: t.last,
        writes: t.writes,
        edits: t.edits,
        sent_to_user: t.sent,
        by_subagent: t.bySubagent,
        named: namedPaths.has(t.path),
        ...describeResult(t.path),
    }));
}
