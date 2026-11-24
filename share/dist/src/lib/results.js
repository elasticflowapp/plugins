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
const WRITE_TOOLS = new Set(["Write", "write_file"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "edit_file", "apply_patch"]);
const SHELL_TOOLS = new Set(["Bash", "exec_command", "run_command", "shell", "shell_command", "local_shell", "container.exec"]);
const BROWSER_TOOL = /(?:chrome|playwright|devtools|browser)/i;
const TEMPLATE_PATH_RE = /(^|\/)(template|skeleton|boilerplate)[^/]*\.html?$/i;
const BUILD_PLACEHOLDER_RE = /\/\*__[A-Z0-9_]+__\*\//;
const MUSTACHE_PLACEHOLDER_RE = /\{\{[^}]{1,80}\}\}/;
const SKIP_WALK_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", "__pycache__", "vendor"]);
const MAX_WALK_DEPTH = 4;
const MAX_WALK_ENTRIES = 2000;
function isEntry(p) { return ENTRY_EXT.has(path.extname(p).toLowerCase()); }
/** True when a file looks like a build skeleton/template rather than a rendered deliverable. */
export function detectTemplateHint(filePath, entryText, bytes) {
    const normalized = filePath.replace(/\\/g, "/");
    if (TEMPLATE_PATH_RE.test(normalized))
        return true;
    if (entryText !== null) {
        if (BUILD_PLACEHOLDER_RE.test(entryText))
            return true;
        if (bytes < 2048 && MUSTACHE_PLACEHOLDER_RE.test(entryText))
            return true;
    }
    return false;
}
function parseIsoMs(ts) {
    if (!ts || !/^\d{4}-\d{2}-\d{2}T/.test(ts))
        return null;
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : null;
}
function addTouch(into, abs, kind, ts, bySubagent) {
    const t = into.get(abs) ?? { path: abs, writes: 0, edits: 0, sent: false, browserOpened: false, bashBuilt: false, last: null, bySubagent };
    if (kind === "write")
        t.writes++;
    else if (kind === "edit")
        t.edits++;
    else if (kind === "sent")
        t.sent = true;
    else if (kind === "browser")
        t.browserOpened = true;
    else if (kind === "bash")
        t.bashBuilt = true;
    if (ts && (t.last === null || ts > t.last))
        t.last = ts;
    if (!bySubagent)
        t.bySubagent = false;
    into.set(abs, t);
}
function extractUrlsFromInput(value, out, depth = 0) {
    if (depth > 4 || value === null || value === undefined)
        return;
    if (typeof value === "string") {
        if (/^(?:file|https?):\/\//i.test(value.trim()))
            out.push(value.trim());
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value)
            extractUrlsFromInput(item, out, depth + 1);
        return;
    }
    if (typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
            if (k === "url" || k === "uri" || k === "href" || k === "actions" || k === "input" || k === "params") {
                extractUrlsFromInput(v, out, depth + 1);
            }
        }
    }
}
/** Extract explicit .html/.htm path references mentioned in a shell command string (redirections, -o flags, filenames). */
function htmlTokensInShellCommand(command) {
    const found = [];
    const seen = new Set();
    // Match quoted or unquoted path tokens ending in .html or .htm (excluding http(s):// remote URLs)
    for (const m of command.matchAll(/(?:["'`]([^"'`\r\n]{1,300}\.html?)["'`]|(?:^|[\s>=,])([^\s"'`<>&|;()]{1,300}\.html?)(?=$|[\s"'`<>&|;),]))/gi)) {
        const raw = (m[1] ?? m[2] ?? "").trim();
        if (!raw || /^(?:https?:|mailto:|data:)/i.test(raw))
            continue;
        if (/[*?$`{}[\]]/.test(raw))
            continue;
        if (raw.toLowerCase().startsWith("file://")) {
            try {
                const u = new URL(raw);
                const p = decodeURIComponent(u.pathname);
                if (isEntry(p) && !seen.has(p)) {
                    seen.add(p);
                    found.push(p);
                }
            }
            catch { /* ignore malformed url */ }
            continue;
        }
        const clean = raw.replace(/^--?(?:out|output|file|page)=/i, "");
        if (!clean || !isEntry(clean))
            continue;
        if (!seen.has(clean)) {
            seen.add(clean);
            found.push(clean);
        }
    }
    return found;
}
/** Every .html the transcript wrote, edited, sent, opened in a browser, or referenced in shell commands, keyed by absolute path. */
export function collectTouchedPages(jsonl, bySubagent = false, into = new Map(), ctx) {
    for (const rec of records(jsonl)) {
        const cwd = typeof rec["cwd"] === "string" && path.isAbsolute(rec["cwd"]) ? path.normalize(rec["cwd"]) : null;
        const ts = typeof rec["timestamp"] === "string" ? rec["timestamp"] : null;
        if (ctx) {
            if (cwd)
                ctx.cwds.add(cwd);
            const ms = parseIsoMs(ts);
            if (ms !== null) {
                if (ctx.minTsMs === null || ms < ctx.minTsMs)
                    ctx.minTsMs = ms;
                if (ctx.maxTsMs === null || ms > ctx.maxTsMs)
                    ctx.maxTsMs = ms;
            }
        }
        if (rec["type"] !== "assistant")
            continue;
        const content = (rec["message"] ?? {})["content"];
        if (!Array.isArray(content))
            continue;
        for (const part of content) {
            if (!part || typeof part !== "object" || part["type"] !== "tool_use")
                continue;
            const name = String(part["name"] ?? "");
            const input = (part["input"] ?? {});
            // Signal 1: Direct file tools
            const directPaths = [];
            let kind = null;
            if (WRITE_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
                if (typeof input["file_path"] === "string")
                    directPaths.push(input["file_path"]);
                if (typeof input["Path"] === "string")
                    directPaths.push(input["Path"]);
                if (name === "apply_patch") {
                    const changes = input["changes"];
                    if (changes && typeof changes === "object" && !Array.isArray(changes)) {
                        for (const [target, ch] of Object.entries(changes)) {
                            const moved = ch && typeof ch === "object" && typeof ch["move_path"] === "string" ? ch["move_path"] : null;
                            if (!ch || typeof ch !== "object" || ch["type"] !== "delete")
                                directPaths.push(moved ?? target);
                        }
                    }
                    else if (typeof input["patch"] === "string") {
                        for (const pm of input["patch"].matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm))
                            directPaths.push(pm[1].trim());
                    }
                }
                kind = WRITE_TOOLS.has(name) ? "write" : "edit";
            }
            else if (name === "SendUserFile") {
                if (Array.isArray(input["files"]))
                    for (const f of input["files"])
                        if (typeof f === "string")
                            directPaths.push(f);
                kind = "sent";
            }
            if (kind !== null) {
                for (const raw of directPaths) {
                    if (!isEntry(raw))
                        continue;
                    const abs = path.isAbsolute(raw) ? path.normalize(raw) : cwd ? path.resolve(cwd, raw) : null;
                    if (!abs)
                        continue;
                    addTouch(into, abs, kind, ts, bySubagent);
                }
                continue;
            }
            // Signal 2: Browser inspection & verification tools
            if (BROWSER_TOOL.test(name)) {
                const urls = [];
                extractUrlsFromInput(input, urls);
                for (const rawUrl of urls) {
                    let u;
                    try {
                        u = new URL(rawUrl);
                    }
                    catch {
                        continue;
                    }
                    if (u.protocol === "file:") {
                        let filePath;
                        try {
                            filePath = decodeURIComponent(u.pathname);
                        }
                        catch {
                            continue;
                        }
                        if (!isEntry(filePath))
                            continue;
                        const abs = path.normalize(filePath);
                        addTouch(into, abs, "browser", ts, bySubagent);
                    }
                    else if ((u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1")) {
                        let rel;
                        try {
                            rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
                        }
                        catch {
                            continue;
                        }
                        if (!rel || !isEntry(rel))
                            continue;
                        if (ctx) {
                            ctx.pendingLocalUrls.push({ rel, cwd, ts, bySubagent });
                        }
                        else if (cwd) {
                            const abs = path.resolve(cwd, rel);
                            if (inside(cwd, abs))
                                addTouch(into, abs, "browser", ts, bySubagent);
                        }
                    }
                }
                continue;
            }
            // Signal 3a: Shell commands referencing .html files directly
            if (SHELL_TOOLS.has(name)) {
                const rawCmd = input["command"] ?? input["cmd"];
                const cmd = typeof rawCmd === "string" ? rawCmd : Array.isArray(rawCmd) ? rawCmd.join(" ") : "";
                if (!cmd)
                    continue;
                const cmdCwd = typeof input["cwd"] === "string" && path.isAbsolute(input["cwd"])
                    ? path.normalize(input["cwd"])
                    : cwd;
                if (ctx && cmdCwd)
                    ctx.cwds.add(cmdCwd);
                for (const token of htmlTokensInShellCommand(cmd)) {
                    const abs = path.isAbsolute(token) ? path.normalize(token) : cmdCwd ? path.resolve(cmdCwd, token) : null;
                    if (!abs)
                        continue;
                    // Only record shell-mentioned paths inside the command's folder tree (or absolute paths later verified on disk)
                    if (cmdCwd && !path.isAbsolute(token) && !inside(cmdCwd, abs))
                        continue;
                    addTouch(into, abs, "bash", ts, bySubagent);
                }
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
function isExecutableScriptTag(attrs) {
    if (/\bsrc\s*=/i.test(attrs))
        return false;
    const tm = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attrs);
    if (!tm)
        return true;
    const raw = (tm[1] ?? tm[2] ?? tm[3] ?? "").trim().toLowerCase();
    const mime = raw.split(";")[0].trim();
    return mime === "" || mime === "module" || mime === "text/javascript" || mime === "application/javascript";
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
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (isExecutableScriptTag(m[1]))
            out.push(...refsInJs(m[2]));
    }
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
const nothing = (blocked, bytes = 0) => ({ bytes, sha256: null, isTemplateHint: false, assets: [], skipped: [], remote_hosts: [], total_bytes: bytes, blocked });
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
    const entryText = entryData.toString("utf-8");
    const isTemplateHint = detectTemplateHint(entryPath, entryText, entryData.length);
    const queue = [{ file: entryReal, depth: 0, text: entryText }];
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
        isTemplateHint,
        assets: [...assets.values()].sort((a, b) => a.rel.localeCompare(b.rel)),
        skipped: [...skipped.entries()].map(([ref, reason]) => ({ ref: ref.slice(0, 200), reason })).slice(0, 40),
        remote_hosts: [...hosts].sort().slice(0, 20),
        total_bytes: total,
        blocked: null,
    };
}
function isUnsafeWalkRoot(dir) {
    const norm = path.normalize(dir);
    if (norm === path.parse(norm).root)
        return true;
    const home = process.env["HOME"] ? path.normalize(process.env["HOME"]) : null;
    if (home && norm === home)
        return true;
    if (norm === "/tmp" || norm === "/private/tmp" || norm === "/var" || norm === "/Users")
        return true;
    return false;
}
/** Deduplicate session cwds to their highest non-nested roots so each tree is walked once. */
function topLevelRoots(cwds) {
    const real = [];
    for (const c of cwds) {
        try {
            const r = fs.realpathSync(c);
            if (!isUnsafeWalkRoot(r) && fs.statSync(r).isDirectory() && !real.includes(r))
                real.push(r);
        }
        catch { /* folder gone */ }
    }
    real.sort((a, b) => a.length - b.length || a.localeCompare(b));
    const roots = [];
    for (const r of real) {
        if (!roots.some((parent) => inside(parent, r)))
            roots.push(r);
    }
    return roots;
}
/** Bounded walk of session workspace folders for .html/.htm files modified during the session window. */
function walkWorkspaceDeliverables(roots, minTsMs, maxTsMs, into) {
    const windowStart = minTsMs - 5_000;
    const windowEnd = maxTsMs + 60_000;
    let seenEntries = 0;
    const stack = roots.map((dir) => ({ dir, depth: 0 }));
    while (stack.length > 0 && seenEntries < MAX_WALK_ENTRIES) {
        const { dir, depth } = stack.pop();
        let dirents;
        try {
            dirents = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const d of dirents) {
            if (++seenEntries > MAX_WALK_ENTRIES)
                break;
            if (d.name.startsWith("."))
                continue;
            const full = path.join(dir, d.name);
            if (d.isSymbolicLink())
                continue;
            if (d.isDirectory()) {
                if (depth + 1 <= MAX_WALK_DEPTH && !SKIP_WALK_DIRS.has(d.name)) {
                    stack.push({ dir: full, depth: depth + 1 });
                }
                continue;
            }
            if (!d.isFile() || !isEntry(d.name))
                continue;
            let st;
            try {
                st = fs.statSync(full);
            }
            catch {
                continue;
            }
            if (st.mtimeMs < windowStart || st.mtimeMs > windowEnd)
                continue;
            const mtimeIso = new Date(st.mtimeMs).toISOString();
            const existing = into.get(full);
            if (existing) {
                existing.bashBuilt = true;
                if (existing.last === null || mtimeIso > existing.last)
                    existing.last = mtimeIso;
            }
            else {
                addTouch(into, full, "bash", mtimeIso, false);
            }
        }
    }
}
/**
 * Result candidates of a session: the pages the person named first, then the
 * pages the session touched, opened in a browser, or compiled in its workspace —
 * real deliverables ranked ahead of skeleton templates, most recently touched first.
 *
 * `transcripts` is the main transcript followed by each sub-agent's. `notes`
 * collects what the caller must tell the person: a named file that is not
 * there, touched pages that did not fit the list.
 */
export function findResultCandidates(transcripts, extraPaths = [], notes = [], opts = {}) {
    const touched = new Map();
    const ctx = {
        cwds: new Set((opts.cwds ?? []).filter((c) => typeof c === "string" && path.isAbsolute(c)).map((c) => path.normalize(c))),
        minTsMs: typeof opts.startedAtMs === "number" && Number.isFinite(opts.startedAtMs) ? opts.startedAtMs : null,
        maxTsMs: typeof opts.endedAtMs === "number" && Number.isFinite(opts.endedAtMs) ? opts.endedAtMs : null,
        pendingLocalUrls: [],
    };
    for (const t of transcripts)
        collectTouchedPages(t.jsonl, t.subagent, touched, ctx);
    const isFile = (p) => { try {
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    } };
    // Resolve localhost/127.0.0.1 browser URLs against recorded session working directories
    const walkRoots = topLevelRoots(ctx.cwds);
    const allCwds = [...new Set([...walkRoots, ...ctx.cwds])];
    for (const pending of ctx.pendingLocalUrls) {
        const searchDirs = pending.cwd ? [pending.cwd, ...allCwds.filter((d) => d !== pending.cwd)] : allCwds;
        for (const base of searchDirs) {
            const candidate = path.resolve(base, pending.rel);
            if (!inside(base, candidate))
                continue;
            if (isFile(candidate)) {
                addTouch(touched, candidate, "browser", pending.ts, pending.bySubagent);
                break;
            }
        }
    }
    // Signal 3b: Bounded workspace walk for script-built HTML deliverables modified within the session window
    if (ctx.minTsMs !== null && ctx.maxTsMs !== null && walkRoots.length > 0) {
        walkWorkspaceDeliverables(walkRoots, ctx.minTsMs, ctx.maxTsMs, touched);
    }
    // Normalize map keys by realpath where possible so symlinked/relative aliases collapse to one candidate.
    // For browser-opened and bash-mentioned paths (not directly written/sent), require them to live inside the session's workspace roots when roots are known.
    const deduped = new Map();
    for (const t of touched.values()) {
        let key = t.path;
        try {
            if (fs.statSync(t.path).isFile())
                key = fs.realpathSync(t.path);
        }
        catch {
            continue;
        }
        const direct = t.writes > 0 || t.edits > 0 || t.sent;
        if (!direct && walkRoots.length > 0 && !walkRoots.some((r) => inside(r, key)))
            continue;
        const existing = deduped.get(key);
        if (!existing) {
            deduped.set(key, { ...t, path: key });
        }
        else {
            existing.writes += t.writes;
            existing.edits += t.edits;
            existing.sent = existing.sent || t.sent;
            existing.browserOpened = existing.browserOpened || t.browserOpened;
            existing.bashBuilt = existing.bashBuilt || t.bashBuilt;
            if (t.last && (existing.last === null || t.last > existing.last))
                existing.last = t.last;
            if (!t.bySubagent)
                existing.bySubagent = false;
        }
    }
    // A page the person named is why they re-ran prepare: it is listed whatever
    // else there is, and a path that does not lead to a file is said out loud.
    const named = [];
    const namedPaths = new Set();
    for (const p of extraPaths) {
        const abs = path.resolve(p);
        if (!isFile(abs)) {
            notes.push(`--result ${p}: there is no such file — it is not listed`);
            continue;
        }
        let real = abs;
        try {
            real = fs.realpathSync(abs);
        }
        catch { /* keep abs */ }
        if (namedPaths.has(real))
            continue;
        namedPaths.add(real);
        named.push(deduped.get(real) ?? { path: real, writes: 0, edits: 0, sent: false, browserOpened: false, bashBuilt: false, last: null, bySubagent: false });
    }
    const restRaw = [...deduped.values()].filter((t) => !namedPaths.has(t.path) && isFile(t.path));
    const restWithDesc = restRaw.map((touch) => ({ touch, described: describeResult(touch.path) }));
    restWithDesc.sort((a, b) => Number(a.described.isTemplateHint) - Number(b.described.isTemplateHint) ||
        (b.touch.last ?? "").localeCompare(a.touch.last ?? "") ||
        Number(b.touch.sent) - Number(a.touch.sent) ||
        Number(b.touch.browserOpened) - Number(a.touch.browserOpened) ||
        a.touch.path.localeCompare(b.touch.path));
    const listed = restWithDesc.slice(0, RESULT_LIMITS.maxCandidates);
    if (restWithDesc.length > listed.length) {
        notes.push(`${restWithDesc.length - listed.length} more page(s) the session touched are not listed (the ${RESULT_LIMITS.maxCandidates} most recent are) — name one with --result "<path>" to list it`);
    }
    const all = [
        ...named.map((touch) => ({ touch, described: describeResult(touch.path), isNamed: true })),
        ...listed.map((item) => ({ ...item, isNamed: false })),
    ];
    return all.map(({ touch: t, described, isNamed }, i) => ({
        id: i + 1,
        entry: path.basename(t.path),
        path: t.path,
        last_touched_at: t.last,
        writes: t.writes,
        edits: t.edits,
        sent_to_user: t.sent,
        by_subagent: t.bySubagent,
        named: isNamed,
        ...described,
    }));
}
