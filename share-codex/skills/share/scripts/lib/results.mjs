// "Results" are the things a session MADE, as opposed to the conversation that
// made them: an HTML page (and the local files it loads), so a reader can run
// the result, not only read how it came about (ADR-0028).
//
// This client does not read the session's format, so it does not know which
// pages the session wrote: the server says, in its answer to the upload — the
// names only, read from the record this client sent (ADR-0033). Everything else
// happens here, on the publisher's machine:
//
//   listResults      which of those pages are files in the session's own folder,
//                    and exactly which files each would publish. Nothing leaves.
//   planResultsUpload the request that carries the results the person chose —
//                    every file checked again, byte for byte what was listed.
//
// A result leaves the machine only after the person has been shown the list and
// said yes (SKILL.md), and only through `send-results`.
//
// What a server's answer can and cannot do here. It names pages; a name is
// listed only when it is an absolute, plain path to an .html file that exists,
// is not a link, and sits inside a folder the session ran in — and not in a
// hidden or a dependency folder there. Anything else is counted, never printed
// and never read; a name outside the session's folders is not even looked up on
// disk. A page anywhere else is listed only when the person names it
// (`--result`). Its files are found by following the page's own local
// references — never by taking the folder around it — and each is checked
// against the rules the server applies (result-types.mjs) while it is still only
// a candidate, so what is listed as "will be published" is what the server will
// take.
//
// A yes is a yes to ONE list. Every list has an id made of what it holds (the
// pages, their files, the digests); `send-results` takes that id with the
// result numbers and sends only while the list on disk is still that list, made
// for the snapshot it is sending. A result's number stays with its page for as
// long as the snapshot is the same, however often the list is made again.
//
// `describeResult` and the reference discovery under it are the Claude Code
// client's (packages/ef-share-plugin/src/lib/results.ts, upload.ts) without
// their types, with one rule added: a page that is itself a symbolic link is not
// published. This file is the same in the Codex and the Antigravity client.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { gzipSync } from "node:zlib"
import { Worker } from "node:worker_threads"
import { RESULT_MIME, ENTRY_EXT, mimeFor, unpublishablePath, unpublishableEntry } from "./result-types.mjs"
import { PREVIEW, captureResultPreview, pngSize, previewsOff } from "./preview.mjs"

export const RESULT_LIMITS = {
  maxEntryBytes: 8 * 1024 * 1024,
  maxAssetBytes: 8 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxAssets: 80,
  maxDepth: 3,
  /** pages the session wrote that are listed; a page the person named is always listed on top of these */
  maxCandidates: 12,
}

/** Results one upload may carry (the server's limit: viewer/lib/uploads/staged-upload.ts UPLOAD_LIMITS.results). */
export const MAX_RESULTS_PER_UPLOAD = 12

/** Page names read from one server answer (the server sends at most this many). */
export const MAX_NAMED_BY_SERVER = 50
const MAX_PATH_CHARS = 1024

/** Up to this size the snapshot goes uncompressed. */
export const PLAIN_SNAPSHOT_MAX = 8 * 1024 * 1024
/** Largest request body the publish endpoint is known to take (prod nginx: 25M), with headroom. */
export const DEFAULT_UPLOAD_BUDGET = 22 * 1024 * 1024
/** Multipart framing per part (boundary, disposition, content type), rounded up. */
export const PART_OVERHEAD_BYTES = 200

/** The budget in force. `EF_SHARE_UPLOAD_BUDGET_BYTES` overrides it for an endpoint known to take more (or less). */
export function uploadBudget(env = process.env) {
  const raw = env["EF_SHARE_UPLOAD_BUDGET_BYTES"]
  if (raw && /^\d{1,12}$/.test(raw) && Number(raw) > 0) return Number(raw)
  return DEFAULT_UPLOAD_BUDGET
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

/**
 * A line break, a tab, an escape, a character that reorders or hides text
 * (U+202E, U+2028, a zero-width joiner…): nothing that is printed to the person
 * or the agent as a name may hold one — a name that reads as something else is
 * not shown at all.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const UNPRINTABLE_ALL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** Asset types a page can load. Anything else a reference points at stays on disk. */
const ASSET_EXT = new Set(Object.keys(RESULT_MIME).filter((ext) => !ENTRY_EXT.has(ext)))

function isEntry(p) { return ENTRY_EXT.has(path.extname(p).toLowerCase()) }

// ─── local reference discovery ───────────────────────────────────────────────

const REMOTE = /^(?:https?:)?\/\//i
const NOT_A_FILE = /^(?:data:|blob:|javascript:|mailto:|tel:|about:|#)/i

// The markup entities, and the Latin-1 names (&nbsp; … &yuml; are U+00A0 … U+00FF,
// in this order) — the ones a file name in a European language is written with.
// HTML defines some 2,200 more; a reference that still holds one after decoding
// is reported as such, not as a missing file.
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml"
const NAMED_ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }
LATIN1.split(" ").forEach((name, i) => { NAMED_ENTITIES[name] = String.fromCodePoint(0xa0 + i) })
const UNDECODED_ENTITY = /&[A-Za-z][A-Za-z0-9]{1,30};/

/** An HTML attribute value as the browser reads it: `a&amp;b.png` names the file `a&b.png`. */
export function decodeEntities(value) {
  if (!value.includes("&")) return value
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,30}));/g, (whole, dec, hex, name) => {
    if (dec !== undefined || hex !== undefined) {
      const cp = dec !== undefined ? Number(dec) : parseInt(hex, 16)
      try { return String.fromCodePoint(cp) } catch { return whole }
    }
    // entity names are case-sensitive (&Eacute; is É, &eacute; is é)
    return NAMED_ENTITIES[String(name)] ?? whole
  })
}

/**
 * True when publishing `key` beside the names already `taken` would collide on
 * the server, which compares names case-insensitively and NFC-normalised and
 * refuses a result in which one path is both a file and a folder of another.
 * Keys are `rel.normalize("NFC").toLowerCase()`.
 */
export function nameCollides(taken, key) {
  if (taken.has(key)) return true
  for (const other of taken) if (other.startsWith(key + "/") || key.startsWith(other + "/")) return true
  return false
}

const TEMPLATE_PATH_RE = /(^|\/)(template|skeleton|boilerplate)[^/]*\.html?$/i
const BUILD_PLACEHOLDER_RE = /\/\*__[A-Z0-9_]+__\*\//
const MUSTACHE_PLACEHOLDER_RE = /\{\{[^}]{1,80}\}\}/

/** True when a file looks like an unexpanded build template / skeleton rather than a real deliverable. */
export function detectTemplateHint(filePath, entryText, bytes) {
  const normalized = String(filePath).replace(/\\/g, "/")
  if (TEMPLATE_PATH_RE.test(normalized)) return true
  if (typeof entryText === "string") {
    if (BUILD_PLACEHOLDER_RE.test(entryText)) return true
    if (bytes < 2048 && MUSTACHE_PLACEHOLDER_RE.test(entryText)) return true
  }
  return false
}

function isExecutableScriptTag(attrs) {
  if (/\bsrc\s*=/i.test(attrs)) return false
  const tm = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attrs)
  if (!tm) return true
  const raw = (tm[1] ?? tm[2] ?? tm[3] ?? "").trim().toLowerCase()
  const mime = raw.split(";")[0].trim()
  return mime === "" || mime === "module" || mime === "text/javascript" || mime === "application/javascript"
}

function refsInHtml(html) {
  const out = []
  const attr = (v) => decodeEntities(v ?? "")
  // src / poster / data on any element; href only on <link> (an <a href> is navigation, not a dependency)
  for (const m of html.matchAll(/\b(?:src|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) out.push(attr(m[1] ?? m[2]))
  for (const m of html.matchAll(/<link\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) out.push(attr(m[1] ?? m[2]))
  for (const m of html.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const cand of attr(m[1] ?? m[2]).split(",")) out.push(cand.trim().split(/\s+/)[0] ?? "")
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push(...refsInCss(m[1]))
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (isExecutableScriptTag(m[1])) out.push(...refsInJs(m[2]))
  }
  return out
}

function refsInCss(css) {
  const out = []
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) out.push(m[1] ?? m[2] ?? m[3] ?? "")
  for (const m of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) out.push(m[1] ?? m[2] ?? "")
  return out
}

/**
 * A script names its dependencies in string literals (import, fetch, new URL,
 * a loader's .load). Any literal that looks like a relative file of a
 * publishable type is a candidate; whether it is published is decided by the
 * same checks as every other reference — it must exist, inside the page's folder.
 */
function refsInJs(js) {
  const out = []
  for (const m of js.matchAll(/(["'`])((?:\.{0,2}\/)?[\w@%+~.\-/]{1,200}\.[A-Za-z0-9]{1,5})(?:[?#][^"'`]*)?\1/g)) {
    if (ASSET_EXT.has(path.extname(m[2]).toLowerCase())) out.push(m[2])
  }
  return out
}

function inside(root, p) {
  const rel = path.relative(root, p)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function readBytes(p) {
  try { return fs.readFileSync(p) } catch { return null }
}

export const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex")

const nothing = (blocked, bytes = 0) => ({ bytes, sha256: null, isTemplateHint: false, assets: [], skipped: [], remote_hosts: [], total_bytes: bytes, blocked })

/** Said of a page that is a link: what is published is a file, under its own name, from its own folder. */
const IS_A_LINK = "a symbolic link — a result is the file itself: name the file it leads to"

/**
 * Exactly what publishing the page at `entryPath` would publish: the page and
 * the local files it loads from its own folder, each with its size and digest;
 * what it refers to that will NOT be published, and why; the hosts it loads
 * from. `blocked` says why the page cannot be published as it stands.
 */
export function describeResult(entryPath) {
  const L = RESULT_LIMITS
  let entryReal
  let entryStat
  try {
    // The page itself may not be a link: it would be published under the link's name from
    // the folder of whatever it leads to. (A folder above it may be one — /tmp is, on macOS.)
    if (fs.lstatSync(entryPath).isSymbolicLink()) return nothing(IS_A_LINK)
    entryReal = fs.realpathSync(entryPath)
    entryStat = fs.statSync(entryReal)
  } catch {
    return nothing("the file no longer exists")
  }
  if (!entryStat.isFile()) return nothing("not a regular file")
  // The entry is published under its own file name: it has to be a name the server stores.
  const entryProblem = unpublishableEntry(path.basename(entryPath))
  if (entryProblem) return nothing(entryProblem, entryStat.size)
  if (entryStat.size > L.maxEntryBytes) return nothing(`the page is larger than ${Math.round(L.maxEntryBytes / 1048576)} MB`, entryStat.size)
  // Each listed file is read ONCE here: its size, its digest and the references in it come
  // from the same bytes. The digest is what "unchanged since listed" means at upload — a
  // size alone is the same for any other content of that length.
  const entryData = readBytes(entryReal)
  if (entryData === null) return nothing("the file could not be read", entryStat.size)
  if (entryData.length > L.maxEntryBytes) return nothing(`the page is larger than ${Math.round(L.maxEntryBytes / 1048576)} MB`, entryData.length)

  const root = path.dirname(entryReal)
  const assets = new Map()
  const skipped = new Map()
  const hosts = new Set()
  let total = entryData.length
  const nameKey = (rel) => rel.normalize("NFC").toLowerCase()
  const taken = new Set([nameKey(path.basename(entryPath))])

  const entryText = entryData.toString("utf-8")
  const isTemplateHint = detectTemplateHint(entryPath, entryText, entryData.length)
  const queue = [{ file: entryReal, depth: 0, text: entryText }]
  const visited = new Set([entryReal])

  while (queue.length > 0) {
    const { file, depth, text } = queue.shift()
    const ext = path.extname(file).toLowerCase()
    const refs = ENTRY_EXT.has(ext) ? refsInHtml(text) : ext === ".css" ? refsInCss(text) : (ext === ".js" || ext === ".mjs") ? refsInJs(text) : []
    for (const raw of refs) {
      const ref = raw.trim()
      if (!ref || NOT_A_FILE.test(ref)) continue
      if (REMOTE.test(ref)) {
        try { hosts.add(new URL(ref.startsWith("//") ? `https:${ref}` : ref).host) } catch { /* not a url */ }
        continue
      }
      const clean = ref.split(/[?#]/)[0]
      if (!clean) continue
      let decoded
      try { decoded = decodeURIComponent(clean) } catch { decoded = clean }
      if (decoded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(decoded)) { skipped.set(ref, "absolute path — only files beside the page are published"); continue }
      const target = path.resolve(path.dirname(file), decoded)
      let real
      try { real = fs.realpathSync(target) } catch {
        const entity = UNDECODED_ENTITY.exec(ref)
        skipped.set(ref, entity ? `not found on disk as written — "${entity[0]}" is an HTML entity this tool does not decode; write the character itself` : "not found on disk")
        continue
      }
      if (visited.has(real)) continue
      if (!inside(root, real)) { skipped.set(ref, "outside the page's folder"); continue }
      const rel = path.relative(root, real).split(path.sep).join("/")
      const problem = unpublishablePath(rel)
      if (problem) { skipped.set(ref, problem); continue }
      const aext = path.extname(real).toLowerCase()
      if (!ASSET_EXT.has(aext)) { skipped.set(ref, "another page — a result is one page and the files it loads"); continue }
      let st
      try { st = fs.statSync(real) } catch { skipped.set(ref, "not found on disk"); continue }
      if (!st.isFile()) continue
      if (st.size > L.maxAssetBytes) { skipped.set(ref, `larger than ${Math.round(L.maxAssetBytes / 1048576)} MB`); continue }
      if (assets.size >= L.maxAssets) { skipped.set(ref, `more than ${L.maxAssets} files`); continue }
      if (total + st.size > L.maxTotalBytes) { skipped.set(ref, `the result would exceed ${Math.round(L.maxTotalBytes / 1048576)} MB`); continue }
      const key = nameKey(rel)
      if (nameCollides(taken, key)) { skipped.set(ref, "its name differs from another published file only by letter case, or is also a folder"); continue }
      const data = readBytes(real)
      if (data === null) { skipped.set(ref, "could not be read"); continue }
      // the file grew between the look at its size and the read: judged by what was read
      if (data.length > L.maxAssetBytes) { skipped.set(ref, `larger than ${Math.round(L.maxAssetBytes / 1048576)} MB`); continue }
      if (total + data.length > L.maxTotalBytes) { skipped.set(ref, `the result would exceed ${Math.round(L.maxTotalBytes / 1048576)} MB`); continue }
      taken.add(key)
      visited.add(real)
      assets.set(real, { rel, abs: real, bytes: data.length, sha256: sha256Hex(data) })
      total += data.length
      if (depth + 1 < L.maxDepth && (aext === ".css" || aext === ".js" || aext === ".mjs")) queue.push({ file: real, depth: depth + 1, text: data.toString("utf-8") })
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
  }
}

// ─── the list ────────────────────────────────────────────────────────────────

/**
 * The page names in a server's answer to the upload (`resultCandidates`,
 * ADR-0033), each checked for its SHAPE only: a string that is an absolute,
 * already normalised path to an .html file. `known` is false when the answer
 * has no such list — a server that does not name pages. `unusable` counts the
 * entries that are not such a path; they are dropped, never printed.
 */
export function pagesFromAnswer(answer) {
  const list = isObj(answer) && isObj(answer.resultCandidates) && Array.isArray(answer.resultCandidates.pages) ? answer.resultCandidates.pages : null
  if (list === null) return { known: false, pages: [], unusable: 0, more: 0 }
  const pages = []
  const seen = new Set()
  let unusable = 0
  for (const raw of list.slice(0, MAX_NAMED_BY_SERVER)) {
    const p = isObj(raw) ? raw.path : null
    const plain = typeof p === "string" && p.length > 0 && p.length <= MAX_PATH_CHARS && !UNPRINTABLE.test(p)
    if (!plain || !path.isAbsolute(p) || path.normalize(p) !== p || !isEntry(p)) { unusable++; continue }
    if (seen.has(p)) continue
    seen.add(p)
    const count = (v) => (Number.isInteger(v) && v >= 0 && v < 1e6 ? v : 0)
    const at = typeof raw.last_touched_at === "string" && raw.last_touched_at.length <= 40 && !Number.isNaN(Date.parse(raw.last_touched_at)) ? raw.last_touched_at : null
    pages.push({ path: p, writes: count(raw.writes), edits: count(raw.edits), last_touched_at: at })
  }
  const total = Number.isInteger(answer.resultCandidates.total_pages) ? answer.resultCandidates.total_pages : list.length
  return { known: true, pages, unusable, more: Math.max(0, total - Math.min(list.length, MAX_NAMED_BY_SERVER)) }
}

/**
 * The folders the session ran in, each as it was said and as it really is (a
 * folder said through a link — the temp folder on macOS — is both): only
 * absolute ones, and never the file system's root. `real` holds the ones that
 * exist.
 */
function sessionRoots(folders) {
  const said = []
  const real = []
  for (const f of folders) {
    if (typeof f !== "string" || !path.isAbsolute(f)) continue
    const plain = path.normalize(f)
    if (plain !== path.parse(plain).root && !said.includes(plain)) said.push(plain)
    try {
      const r = fs.realpathSync.native(f)
      if (r !== path.parse(r).root && fs.statSync(r).isDirectory() && !real.includes(r)) real.push(r)
    } catch { /* the folder is gone */ }
  }
  return { said: [...new Set([...said, ...real])], real }
}

/** A folder a session's own page does not live in: hidden, or other people's code. */
const NOT_THE_SESSIONS_OWN = (segment) => segment.startsWith(".") || segment === "node_modules"

/**
 * Where a page the server named stands: `{ file }` — the page as it is spelled
 * on disk — when it is a regular file, not a link, inside one of the session's
 * folders and not in a hidden or a dependency folder there; else why not.
 * A name that is not even written as a path inside those folders is not looked
 * up at all: whether such a file exists is nobody's to learn from the notes.
 */
function locate(named, roots) {
  if (!roots.said.some((root) => inside(root, named))) return { not: "outside" }
  let file
  try {
    if (!fs.lstatSync(named).isFile()) return { not: "gone" } // not there any more, a folder, or a link
    file = fs.realpathSync.native(named) // through the links above it, and in the letter case the disk has
  } catch { return { not: "gone" } }
  const root = roots.real.find((r) => inside(r, file))
  if (!root) return { not: "outside" } // a folder inside the session's folder that leads out of it
  if (path.relative(root, file).split(path.sep).slice(0, -1).some(NOT_THE_SESSIONS_OWN)) return { not: "hidden" }
  return { file }
}

/**
 * Which pages one publish lists, and under which numbers: the pages the person
 * named first, then the pages the server named that are files inside the
 * session's own folders, most recently touched first. Looks at names on disk
 * only — no page is read here.
 *
 *   pages     from pagesFromAnswer — names, and nothing but names
 *   folders   the folders the session ran in, as its record says them
 *   named     paths the person named now (`--result`), relative to `cwd`
 *   previous  the list made before for this same snapshot: the pages the
 *             person named then are still named, and every page keeps its number
 *
 * `notes` is what the caller must tell the person: a named file that is not
 * there, pages that were not listed and why — in counts; a name the server gave
 * that did not lead to a file in the session's folder is never repeated.
 */
export function selectPages({ pages = [], folders = [], named = [], cwd = process.cwd(), previous = [] }) {
  const notes = []
  const roots = sessionRoots(folders)
  const lstat = (p) => { try { return fs.lstatSync(p) } catch { return null } }
  const before = Array.isArray(previous) ? previous.filter((r) => isObj(r) && typeof r.path === "string" && Number.isInteger(r.id) && r.id >= 1) : []

  // A page the person named is why they asked again: it is listed whatever else
  // there is, and a path that does not lead to a file is said out loud. One
  // named for an earlier list of this snapshot stays named.
  const first = []
  const namedPaths = new Set()
  const name = (given, said) => {
    const st = lstat(given)
    // a link is listed, so that the person is told why it is not published (describeResult)
    if (!st || !(st.isFile() || st.isSymbolicLink())) {
      notes.push(said === null ? `a page named before is no longer a file and is not listed: ${path.basename(given).replace(UNPRINTABLE_ALL, "?")}` : `--result ${said}: there is no such file — it is not listed`)
      return
    }
    // a file is listed as the disk spells it, so that one file is one page however it was named
    let abs = given
    if (st.isFile()) try { abs = fs.realpathSync.native(given) } catch { /* listed as it was named */ }
    if (namedPaths.has(abs)) return
    namedPaths.add(abs)
    const known = pages.find((c) => c.path === abs)
    first.push({ path: abs, writes: known?.writes ?? 0, edits: known?.edits ?? 0, last_touched_at: known?.last_touched_at ?? null })
  }
  for (const r of before) if (r.named === true && path.isAbsolute(r.path)) name(r.path, null)
  for (const p of named) name(path.resolve(cwd, p), p)

  const not = { gone: 0, outside: 0, hidden: 0 }
  const rest = []
  const seen = new Set()
  for (const page of pages) {
    if (namedPaths.has(page.path)) continue
    const at = locate(page.path, roots)
    if (at.not) { not[at.not]++; continue }
    // one file is one page, under whatever spellings it was named
    if (seen.has(at.file) || namedPaths.has(at.file)) continue
    seen.add(at.file)
    rest.push({ ...page, path: at.file })
  }
  const listed = rest.slice(0, RESULT_LIMITS.maxCandidates)
  if (rest.length > listed.length) {
    notes.push(`${rest.length - listed.length} more page(s) the session wrote are not listed (the ${RESULT_LIMITS.maxCandidates} most recent are) — name one with --result "<path>" to list it`)
  }
  if (not.outside > 0) {
    notes.push(
      roots.real.length === 0
        ? `${not.outside} page(s) the session wrote are not listed: the folder the session ran in is not known here — name one with --result "<path>" to list it`
        : `${not.outside} page(s) the session wrote outside its own folder are not listed — name one with --result "<path>" to list it`,
    )
  }
  if (not.hidden > 0) notes.push(`${not.hidden} page(s) in a hidden or a dependency folder (a name that starts with a dot, node_modules) are not listed — name one with --result "<path>" to list it`)
  if (not.gone > 0) notes.push(`${not.gone} page(s) the session wrote are no longer files on this machine and are not listed`)

  // A result's number is its page's for as long as the snapshot is the same: a
  // list made again — after a page was named, after a failed publish — never
  // gives a number to another page.
  const numberOf = new Map(before.map((r) => [r.path, r.id]))
  let next = before.reduce((max, r) => Math.max(max, r.id), 0) + 1
  const selected = [...first, ...listed].map((t) => ({ ...t, id: numberOf.get(t.path) ?? next++, named: namedPaths.has(t.path) }))
  return { selected, notes }
}

/** A selected page with what publishing it would publish (describeResult): one entry of the list. */
function listEntry(t, described) {
  // where the page really is: `send-results` sends it only while it is still there
  let real = null
  if (described.blocked === null) try { real = fs.realpathSync(t.path) } catch { /* gone since: refused when sent */ }
  return { id: t.id, entry: path.basename(t.path), path: t.path, real, last_touched_at: t.last_touched_at, writes: t.writes, edits: t.edits, named: t.named, ...described }
}

/** The result candidates of one publish (selectPages), each with exactly what it would publish. */
export function listResults(args) {
  const { selected, notes } = selectPages(args)
  return { results: selected.map((t) => listEntry(t, describeResult(t.path))), notes }
}

/** A reference as a page wrote it, fit to be shown: cut short, with nothing in it that reorders or hides text. */
const shownReference = (ref) => (ref.length > 120 ? ref.slice(0, 120) + "…" : ref).replace(UNPRINTABLE_ALL, "?")

/**
 * What the person is shown of the list. A result is published byte for byte
 * and cannot be redacted, so the question "share this result?" is asked over
 * the FILES, not over a count of them. `room`: what is left of one upload
 * beside the snapshot. Everything here but the numbers is text a page or a
 * folder holds — names and references, never something to act on.
 */
export function resultsForDisplay(results, room) {
  return results.map((r) => ({
    id: r.id,
    entry: r.entry,
    path: r.path,
    named_by_you: r.named,
    ...(r.isTemplateHint ? { isTemplateHint: true } : {}),
    files: [r.entry, ...r.assets.map((a) => a.rel)],
    total_bytes: r.total_bytes,
    // each file is a part of the request and a line of its manifest, besides its own bytes
    fits_this_upload: r.blocked === null && r.total_bytes + (r.assets.length + 3) * (PART_OVERHEAD_BYTES + 200) + r.assets.reduce((n, a) => n + a.rel.length, 0) <= room,
    last_touched_at: r.last_touched_at,
    not_published: r.skipped.map((s) => ({ ref: shownReference(String(s.ref)), reason: s.reason })),
    loads_from_network: r.remote_hosts,
    blocked: r.blocked,
  }))
}

/**
 * What is left of one upload for results, beside the snapshot — which goes
 * compressed when that is what makes room, so the room is counted with the
 * smaller of the two (planResultsUpload does the same).
 */
export function roomForResults(snapshot, budget = uploadBudget()) {
  const sent = snapshot.length > PLAIN_SNAPSHOT_MAX ? gzipSync(snapshot).length : Math.min(snapshot.length, gzipSync(snapshot).length)
  return Math.max(0, budget - sent - 4 * PART_OVERHEAD_BYTES)
}

// ─── the list on disk ────────────────────────────────────────────────────────
//
// The list is kept beside the snapshot, in the private work folder, so that
// `send-results` sends what was LISTED — the files by the digests they had when
// the person was shown them — and not whatever stands at those paths later.
// It says which snapshot it was made for and carries its own id.

const LIST_VERSION = 2

/**
 * The id of a list: made of what would be published — every result's number,
 * page, state and files, by their digests, and the hosts it loads from. Two
 * lists with the same id publish the same thing; a list in which any of that
 * differs has another id. It is 128 bits of a SHA-256: at 48 bits a second list
 * with the id of the first was found in half a minute (review of ADR-0033,
 * verification, N1), and the id is what a yes is given to.
 */
export function listId(results) {
  const told = results.map((r) => [r.id, r.path, r.named === true, r.blocked ?? null, r.sha256 ?? null, (r.assets ?? []).map((a) => [a.rel, a.sha256]), r.remote_hosts ?? []])
  return sha256Hex(Buffer.from(JSON.stringify(told))).slice(0, 32)
}

export function writeListing(file, results, snapshotSha256) {
  fs.rmSync(file, { force: true })
  // "wx": never write through a file or link someone left at this path
  // (`results_list`: the name the commands print the id under — whoever looks for it here finds it)
  fs.writeFileSync(file, JSON.stringify({ list_version: LIST_VERSION, listed_at: new Date().toISOString(), snapshot_sha256: snapshotSha256, results_list: listId(results), results }), { mode: 0o600, flag: "wx" })
}

/**
 * The list `writeListing` wrote for the snapshot with this digest —
 * `{ results, results_list }` — or null when the file is not that: missing, a link,
 * a hard link, writable by someone else, of another shape, made for another
 * snapshot, or changed since it was written (its id is no longer the id of what
 * it holds).
 */
export function readListing(file, snapshotSha256) {
  let st
  try { st = fs.lstatSync(file) } catch { return null }
  if (!st.isFile() || st.nlink > 1) return null
  if (process.platform !== "win32") {
    if ((st.mode & 0o022) !== 0) return null
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null
  }
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!isObj(list) || list.list_version !== LIST_VERSION || !Array.isArray(list.results) || typeof list.results_list !== "string") return null
    if (list.snapshot_sha256 !== snapshotSha256) return null
    if (list.results.some((r) => !isObj(r)) || listId(list.results) !== list.results_list) return null
    return { results: list.results, results_list: list.results_list }
  } catch {
    return null
  }
}

// ─── sending what was chosen ─────────────────────────────────────────────────

export function parseResultSelection(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error('--results takes a comma-separated list of result ids, for example "1,3"')
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean)
  if (ids.length === 0 || ids.some((s) => !/^\d{1,3}$/.test(s) || Number(s) < 1)) throw new Error(`--results takes a comma-separated list of result ids, got "${raw}"`)
  return [...new Set(ids.map(Number))]
}

/** A sha256 as the list records it. */
const DIGEST = /^[0-9a-f]{64}$/

/**
 * A result file as it is about to be read: still where the list found it, still
 * inside the entry page's folder, still a file the server takes. The list was
 * written minutes ago and is only a list.
 */
function checkedResultFile(root, rel, abs) {
  let real
  try { real = fs.realpathSync(abs) } catch { return { problem: `${rel} is no longer on disk` } }
  const back = path.relative(root, real).split(path.sep).join("/")
  if (back !== rel) return { problem: `${rel} is not where it was when the results were listed` }
  const unpublishable = unpublishablePath(rel)
  return unpublishable ? { problem: `${rel}: ${unpublishable}` } : { real }
}

/**
 * The files of one listed result, each checked again by the rules it was listed
 * by (describeResult): the page is the file the list names, where it was, and
 * not a link; every other file is inside the page's folder, not hidden, of a
 * type the server takes; each one is a regular file, the size it was when
 * listed, within the limits of one result. The paths returned are the real ones
 * that were checked — what is read, and what a preview picture is taken of.
 *
 * Each comes with the digest the list recorded. The size says only that a file
 * is as long as it was; whoever reads the file — the upload, the local server
 * the picture is taken from — compares what it read with the digest, and a file
 * that holds something else is not sent or served.
 */
export function resultFiles(r) {
  const L = RESULT_LIMITS
  const MB = 1048576
  const fail = (problem) => ({ files: [], problem })
  const notOurs = "the list of results is not one this tool wrote"
  if (!isObj(r) || typeof r.path !== "string" || !path.isAbsolute(r.path) || typeof r.real !== "string" || typeof r.entry !== "string" || typeof r.bytes !== "number" || !Array.isArray(r.assets)) return fail(notOurs)
  if (path.basename(r.path) !== r.entry) return fail(`the path the list gives for ${r.entry} is another file (${path.basename(r.path)})`)
  let real
  let st
  try {
    if (fs.lstatSync(r.path).isSymbolicLink()) return fail(`${r.entry} is now ${IS_A_LINK}`)
    real = fs.realpathSync(r.path)
    st = fs.statSync(real)
  } catch { return fail(`${r.entry} is no longer on disk`) }
  if (real !== r.real) return fail(`${r.entry} is not where it was when the results were listed`)
  if (!st.isFile()) return fail(`${r.entry} is not a regular file`)
  if (st.size !== r.bytes) return fail(`${r.entry} changed since the results were listed`)
  if (st.size > L.maxEntryBytes) return fail(`${r.entry} is larger than ${Math.round(L.maxEntryBytes / MB)} MB`)
  if (r.assets.length > L.maxAssets) return fail(`it lists more than ${L.maxAssets} files — one result carries at most ${L.maxAssets}`)
  const root = path.dirname(real)
  // the digests are read off the list as they stand and judged once every file has been looked at (below)
  const files = [{ rel: r.entry, abs: real, bytes: st.size, sha256: r.sha256 }]
  const taken = new Set([r.entry.normalize("NFC").toLowerCase()])
  let total = st.size
  for (const a of r.assets) {
    if (!isObj(a) || typeof a.rel !== "string" || typeof a.abs !== "string" || typeof a.bytes !== "number") return fail(notOurs)
    const at = checkedResultFile(root, a.rel, a.abs)
    if (at.problem) return fail(at.problem)
    if (!ASSET_EXT.has(path.extname(a.rel).toLowerCase())) return fail(`${a.rel} is another page — a result is one page and the files it loads`)
    const key = a.rel.normalize("NFC").toLowerCase()
    if (nameCollides(taken, key)) return fail(`${a.rel} is listed twice, or is also a folder of another file`)
    taken.add(key)
    let ast
    try { ast = fs.statSync(at.real) } catch { return fail(`${a.rel} is no longer on disk`) }
    if (!ast.isFile()) return fail(`${a.rel} is not a regular file`)
    if (ast.size !== a.bytes) return fail(`${a.rel} changed since the results were listed`)
    if (ast.size > L.maxAssetBytes) return fail(`${a.rel} is larger than ${Math.round(L.maxAssetBytes / MB)} MB`)
    total += ast.size
    if (total > L.maxTotalBytes) return fail(`the result is larger than ${Math.round(L.maxTotalBytes / MB)} MB`)
    files.push({ rel: a.rel, abs: at.real, bytes: ast.size, sha256: a.sha256 })
  }
  // asked last: every refusal above says more about what is wrong with a file than that its digest is missing
  for (const f of files) if (typeof f.sha256 !== "string" || !DIGEST.test(f.sha256)) return fail(`the list of results records no digest of ${f.rel}`)
  return { files, problem: null }
}

/** The listed result with this id that can be published, or the reason there is none. */
function chosenResult(listing, id) {
  const r = listing.find((c) => isObj(c) && c.id === id)
  if (!r) return { problem: `there is no result ${id} in the list` }
  if (r.blocked) return { problem: `result ${id} (${r.entry}) cannot be published: ${r.blocked}` }
  const entryProblem = typeof r.entry === "string" ? unpublishableEntry(r.entry) : "the list of results is not one this tool wrote"
  if (entryProblem) return { problem: `result ${id} (${r.entry}) cannot be published: ${entryProblem}` }
  return { r }
}

/**
 * The chosen results, each described AFRESH from the disk and held to what the
 * list says of it — so what is sent is what the tool itself finds at the page
 * now, and only when that is what the person was shown. The list on disk says
 * which page a number stands for; it is not what decides which files go.
 *
 *   - a page the server named must still be a file in the session's folder;
 *   - the page and every file it loads must have the digests that were listed,
 *     and the files it loads must be the listed ones — no more, no fewer.
 *
 * Returns the fresh descriptions (in the list's shape) and what is wrong.
 */
export function verifyChosen({ listing, ids, folders = [] }) {
  const results = []
  const errors = []
  const roots = sessionRoots(folders)
  if (ids.length === 0) errors.push("no result was chosen: an upload without results is the plain `upload`")
  else if (ids.length > MAX_RESULTS_PER_UPLOAD) errors.push(`${ids.length} results chosen — one publish takes at most ${MAX_RESULTS_PER_UPLOAD}`)
  else {
    for (const id of ids) {
      const chosen = chosenResult(listing, id)
      if (chosen.problem) { errors.push(chosen.problem); continue }
      const r = chosen.r
      const cannot = (why) => errors.push(`result ${id} (${r.entry}) cannot be published: ${why} — list the results again`)
      if (typeof r.path !== "string" || !path.isAbsolute(r.path) || !Array.isArray(r.assets) || path.basename(r.path) !== r.entry) { cannot("the list of results is not one this tool wrote"); continue }
      if (r.named !== true) {
        const at = locate(r.path, roots)
        if (at.file !== r.path) { cannot(`${r.entry} is no longer a file in the session's folder`); continue }
      }
      const fresh = describeResult(r.path)
      if (fresh.blocked) { cannot(`${r.entry}: ${fresh.blocked}`); continue }
      if (fresh.sha256 !== r.sha256) { cannot(`${r.entry} changed since the results were listed`); continue }
      const listed = new Map(r.assets.filter(isObj).map((a) => [a.rel, a.sha256]))
      const changed = fresh.assets.find((a) => listed.has(a.rel) && listed.get(a.rel) !== a.sha256)
      if (changed) { cannot(`${changed.rel} changed since the results were listed`); continue }
      if (fresh.assets.length !== r.assets.length || fresh.assets.some((a) => !listed.has(a.rel))) { cannot(`the files ${r.entry} loads are not the ones that were listed`); continue }
      let real = null
      try { real = fs.realpathSync(r.path) } catch { /* refused below: resultFiles finds it gone */ }
      results.push({ id, entry: r.entry, path: r.path, real, named: r.named === true, ...fresh })
    }
  }
  return { results, errors }
}

// ─── work that may not hang ──────────────────────────────────────────────────
//
// Finding what a page loads reads the page with regular expressions (the Claude
// Code client's), and a megabyte of markup with an unclosed tag keeps one of
// them busy for a long time. A match cannot be stopped from outside, so each
// page is read in a worker of its own that can: past its limit it is ended and
// THAT page is listed as one that cannot be published — the other pages, and
// the command, go on. (With one worker for the whole list, one such page took
// the list down for every later command: review of ADR-0033, verification, F7.)

export const PAGE_LIMIT_MS = 15_000
export const VERIFY_LIMIT_MS = 20_000

/** Run `describeResult` or `verifyChosen` in a worker, ended at `limitMs`. Rejects with `timedOut: true` when it was. */
export function bounded(task, args, limitMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./results-worker.mjs", import.meta.url), { workerData: { task, args } })
    let done = false
    const finish = (fn, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      worker.terminate().catch(() => undefined)
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, Object.assign(new Error(`reading the page took over ${Math.round(limitMs / 1000)} s`), { timedOut: true })), limitMs)
    worker.once("message", (m) => (m && m.ok ? finish(resolve, m.value) : finish(reject, new Error(m?.error ?? "the worker failed"))))
    worker.once("error", (e) => finish(reject, e))
    worker.once("exit", (code) => finish(reject, new Error(`the worker ended early (${code})`)))
  })
}

/**
 * listResults, with each page read in a worker of its own, all at once, each
 * ended at `limitMs`. A page that could not be read in that time is in the list
 * as blocked, with the reason — it is not left out, and it stops nothing else.
 */
export async function listResultsBounded(args, limitMs = PAGE_LIMIT_MS) {
  const { selected, notes } = selectPages(args)
  const described = await Promise.all(selected.map((t) => bounded("describeResult", t.path, limitMs).catch((e) =>
    nothing(e?.timedOut ? `looking for the files the page loads took over ${Math.round(limitMs / 1000)} s — a page like that cannot be published as a result` : `the page could not be read: ${e?.message ?? e}`))))
  return { results: selected.map((t, i) => listEntry(t, described[i])), notes }
}

/**
 * Take the preview picture of each chosen result (preview.mjs). A result that
 * cannot be published is skipped here — planResultsUpload names why; a picture
 * that could not be taken is a note, never an error: the result is published
 * without one. `pictureFile(id)`: where the picture of result `id` is written.
 */
export async function takeResultPreviews(listing, ids, pictureFile, capture = captureResultPreview, opts = {}) {
  const previews = new Map()
  const notes = []
  if (ids.length === 0 || ids.length > MAX_RESULTS_PER_UPLOAD) return { previews, notes }
  // A picture is taken only of a result that will be published, and only of the files checked for it:
  // the picture is uploaded, so a page that loads a file the result may not carry is not photographed.
  const wanted = ids
    .map((id) => chosenResult(listing, id).r)
    .filter(Boolean)
    .map((r) => ({ r, listed: resultFiles(r) }))
    .filter((w) => w.listed.problem === null)
  if (wanted.length === 0) return { previews, notes }
  // only the built-in capture reads the environment: a capture handed in by the caller is the caller's choice
  if (capture === captureResultPreview && previewsOff()) {
    notes.push("no preview pictures were taken: they are turned off (EF_SHARE_PREVIEW=off)")
    return { previews, notes }
  }
  // One clock for all the pictures: the upload ticket is short-lived, and the pictures are
  // taken before the request is sent.
  const now = opts.now ?? Date.now
  const total = opts.totalMs ?? PREVIEW.totalMs
  const started = now()
  for (const { r, listed } of wanted) {
    const left = total - (now() - started)
    if (left < 1000) {
      notes.push(`no preview picture for result ${r.id} (${r.entry}): the ${Math.round(total / 1000)} s allowed for the pictures of one upload ran out`)
      continue
    }
    let outcome
    try {
      outcome = await capture({
        entry: r.entry,
        // with each file's digest: the local server hands the browser the listed bytes or nothing
        files: listed.files.map((f) => ({ rel: f.rel, abs: f.abs, sha256: f.sha256 })),
        remoteHosts: Array.isArray(r.remote_hosts) ? r.remote_hosts.filter((h) => typeof h === "string") : [],
        outFile: pictureFile(r.id),
        timeoutMs: Math.min(PREVIEW.timeoutMs, left),
      })
    } catch (e) {
      outcome = { ok: false, reason: e?.message ?? String(e) }
    }
    if (outcome.ok) previews.set(r.id, { file: outcome.file, width: outcome.width, height: outcome.height })
    else notes.push(`no preview picture for result ${r.id} (${r.entry}): ${outcome.reason}`)
  }
  return { previews, notes }
}

/**
 * The request that carries the snapshot and the chosen results: its parts, and
 * what the person is told about it. Built completely, measured, and checked
 * against the upload budget BEFORE a byte is sent — `errors` not empty means
 * nothing may be sent.
 *
 *   snapshot  the snapshot's bytes
 *   listing   the results as listed (readListing)
 *   ids       the results the person chose
 *   previews  pictures taken for them (takeResultPreviews)
 */
export function planResultsUpload({ snapshot, listing, ids, previews = new Map(), budget = uploadBudget() }) {
  const errors = []
  const notes = []
  const parts = []
  const sent = []
  const manifest = []
  if (ids.length === 0) errors.push("no result was chosen: an upload without results is the plain `upload`")
  else if (ids.length > MAX_RESULTS_PER_UPLOAD) errors.push(`${ids.length} results chosen — one publish takes at most ${MAX_RESULTS_PER_UPLOAD}`)
  else {
    for (const id of ids) {
      const chosen = chosenResult(listing, id)
      if (chosen.problem) { errors.push(chosen.problem); continue }
      const r = chosen.r
      const files = []
      const staged = []
      let bytes = 0
      const listed = resultFiles(r)
      let problem = listed.problem
      for (const f of listed.files) {
        let buf
        try { buf = fs.readFileSync(f.abs) } catch (e) { problem = `${f.rel} could not be read: ${e.message}`; break }
        // the bytes that are sent are the bytes that were listed: the same length is not the same file
        const digest = sha256Hex(buf)
        if (buf.length !== f.bytes || digest !== f.sha256) { problem = `${f.rel} changed since the results were listed`; break }
        const part = `result.${id}.${files.length}`
        staged.push({ name: part, blob: new Blob([buf], { type: mimeFor(f.rel) }), filename: path.basename(f.rel) })
        files.push({ part, rel: f.rel, bytes: buf.length, sha256: digest })
        bytes += buf.length
      }
      if (problem) { errors.push(`result ${id} (${r.entry}) cannot be published: ${problem} — list the results again`); continue }
      parts.push(...staged)
      // the picture of the page, when one was taken: its own part, never one of the result's files
      let preview
      const taken = previews.get(id)
      if (taken) {
        let png
        try { png = fs.readFileSync(taken.file) } catch { png = null }
        // the numbers sent describe the bytes sent: read from the file, not carried over from the capture
        const size = png ? pngSize(png) : null
        if (png && size) {
          const part = `result.${id}.preview`
          parts.push({ name: part, blob: new Blob([png], { type: "image/png" }), filename: `preview-${id}.png` })
          preview = { part, bytes: png.length, sha256: sha256Hex(png), width: size.width, height: size.height }
        } else {
          notes.push(`no preview picture for result ${id} (${r.entry}): the picture that was taken could not be read back`)
        }
      }
      const hosts = Array.isArray(r.remote_hosts) ? r.remote_hosts.filter((h) => typeof h === "string") : []
      manifest.push({ id, entry: r.entry, files, remote_hosts: hosts, ...(preview ? { preview } : {}) })
      sent.push({ id, entry: r.entry, files: files.length, bytes, preview: !!preview, ...(preview && taken ? { preview_file: taken.file } : {}) })
    }
    if (manifest.length > 0) {
      parts.push({ name: "results.json", blob: new Blob([JSON.stringify({ result_contract_version: "1.0.0", results: manifest })], { type: "application/json" }), filename: "results.json" })
    }
  }

  // The snapshot, sized against what is left of the budget: as written while it
  // fits, compressed when that is what makes room for the results.
  const others = parts.reduce((sum, p) => sum + p.blob.size + PART_OVERHEAD_BYTES, 0)
  const compress = snapshot.length > PLAIN_SNAPSHOT_MAX || others + snapshot.length + PART_OVERHEAD_BYTES > budget
  const main = compress
    ? { name: "session.jsonl.gz", blob: new Blob([gzipSync(snapshot)], { type: "application/gzip" }), filename: "session.jsonl.gz" }
    : { name: "session.jsonl", blob: new Blob([snapshot], { type: "application/jsonl" }), filename: "session.jsonl" }
  const body = others + main.blob.size + PART_OVERHEAD_BYTES
  if (body > budget) {
    const resultBytes = sent.reduce((sum, r) => sum + r.bytes, 0)
    errors.push(`the upload would be ${mb(body)}, over the ${mb(budget)} the endpoint takes — the chosen results are ${mb(resultBytes)} of it: publish fewer or smaller results`)
  }
  return { parts: [main, ...parts], errors, notes, sent: { snapshot_bytes: snapshot.length, snapshot_compressed: compress, results: sent, body_bytes: body, budget_bytes: budget } }
}

const overBudget = (plan) => plan.errors.some((e) => e.startsWith("the upload would be"))

/**
 * planResultsUpload, with the pictures left out when they are what pushes the
 * request over the size the endpoint takes: a picture is a nicety, the result
 * is what was asked for.
 */
export function planResultsUploadFitting(args) {
  const plan = planResultsUpload(args)
  if (!overBudget(plan) || !(args.previews?.size > 0)) return plan
  const without = planResultsUpload({ ...args, previews: new Map() })
  if (overBudget(without)) return plan
  const ids = plan.sent.results.filter((r) => r.preview).map((r) => r.id)
  without.notes.push(`the preview pictures of result${ids.length === 1 ? "" : "s"} ${ids.join(", ")} were left out: with them the upload would be over the size the endpoint takes`)
  return without
}
