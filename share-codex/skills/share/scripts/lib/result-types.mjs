// What a published result may contain — this client's copy of the server's rules
// (viewer/lib/uploads/staged-upload.ts: RESULT_MIME, isSafeResultPath).
//
// The server refuses the WHOLE upload when one result file breaks a rule, after
// every byte has been sent. So the client applies the same rules while it is
// still only listing candidates: a file the server would refuse is shown to the
// person as "not published" with the reason, and never put into a request.
//
// The same module as the Claude Code client's
// (packages/ef-share-plugin/src/lib/result-types.ts), without its types. The
// lists are held equal to the server's by a test (__tests__/result-types.test.mjs
// reads the server file), and this file is the same in the Codex and the
// Antigravity client (ADR-0033).

import path from "node:path"

/** Extension → media type of every file a result may contain. */
export const RESULT_MIME = {
  ".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".csv": "text/csv",
  ".tsv": "text/tab-separated-values", ".md": "text/markdown",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream",
  ".obj": "text/plain", ".mtl": "text/plain", ".hdr": "application/octet-stream",
  ".ktx2": "image/ktx2", ".wasm": "application/wasm",
}

/** A result's entry page. */
export const ENTRY_EXT = new Set([".html", ".htm"])

export function mimeFor(file) {
  return RESULT_MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream"
}

/** One path segment the server stores: letters, digits, space and `._@()+,=~-[]`, not starting with a dot. */
const SEGMENT = /^[\p{L}\p{M}\p{N} ._@()+,=~\-[\]]{1,160}$/u

/**
 * Why `rel` (a path relative to the entry page's folder, POSIX separators)
 * cannot be published — or null when it can. The same checks, in the same
 * order, as the server's isSafeResultPath.
 */
export function unpublishablePath(rel) {
  if (rel.length === 0 || rel.length > 400) return "the path is too long"
  if (rel.includes("\\") || rel.includes("\0") || rel.startsWith("/")) return "not a plain relative path"
  const segs = rel.split("/")
  if (segs.length > 10) return "nested more than 10 folders deep"
  for (const s of segs) {
    if (!s || s === "." || s === "..") return "not a plain relative path"
    if (s.startsWith(".")) return "hidden file"
    if (!SEGMENT.test(s)) return `"${s.slice(0, 60)}" has a character a published file name cannot use (letters, digits, spaces and . _ @ ( ) + , = ~ - [ ] are fine)`
  }
  const ext = path.extname(rel).toLowerCase()
  if (!(ext in RESULT_MIME)) return `${ext || "extensionless"} files are not published`
  return null
}

/** Why `name` cannot be a result's entry page — or null when it can. */
export function unpublishableEntry(name) {
  if (!ENTRY_EXT.has(path.extname(name).toLowerCase())) return "only an .html page can be published as a result"
  return unpublishablePath(name)
}
