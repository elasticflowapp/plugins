// Locating an Antigravity conversation's transcript and taking the snapshot that
// is uploaded.
//
// Antigravity (the app, the `agy` CLI and the IDE share one agent) writes each
// conversation as JSON Lines, one step per line, while the session runs:
//
//   <data dir>/brain/<conversation id>/.system_generated/logs/transcript_full.jsonl
//
// with <data dir> = ~/.gemini/antigravity (app), ~/.gemini/antigravity-cli (CLI)
// or ~/.gemini/antigravity-ide (IDE). The agent's shell is given the conversation
// it belongs to (`ANTIGRAVITY_CONVERSATION_ID`) and its data dir
// (`ANTIGRAVITY_APP_DATA_DIR`) — so the session is found by its own id, never by
// "the newest file".
//
// The snapshot is the transcript as written, whole: what of it is shown on the
// page, and what is never stored, is decided by the server. The transcript holds
// no conversation id, no working directory and no product version, so the
// snapshot begins with one record that says them.
//
// Measured on Antigravity CLI 1.5.11 (2026-11-19): the three variables above and
// `ANTIGRAVITY_LS_VERSION` are in the agent's shell.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// lower case, as Antigravity writes it: the id is also a folder's name, and a
// file system that ignores case would find `3A85…` under `3a85…`
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TRANSCRIPT = [".system_generated", "logs", "transcript_full.jsonl"]

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

export function isConversationId(id) {
  return typeof id === "string" && CONVERSATION_ID.test(id)
}

/** Where Antigravity keeps conversations: the session's own data dir first, then the three products' defaults. */
export function dataDirs(env = process.env, home = os.homedir()) {
  const dirs = []
  const own = env.ANTIGRAVITY_APP_DATA_DIR
  if (typeof own === "string" && own.trim() && path.isAbsolute(own)) dirs.push(path.resolve(own))
  for (const name of ["antigravity", "antigravity-cli", "antigravity-ide"]) {
    const d = path.join(home, ".gemini", name)
    if (!dirs.includes(d)) dirs.push(d)
  }
  return dirs
}

/**
 * The transcript of one conversation, or null. The id is a UUID and names its
 * folder, so the id alone identifies the file — there is no "most recent
 * conversation" guess, which is how the wrong session gets published.
 */
export function findTranscript(conversationId, env = process.env, home = os.homedir()) {
  if (!isConversationId(conversationId)) return null
  for (const dataDir of dataDirs(env, home)) {
    const file = path.join(dataDir, "brain", conversationId, ...TRANSCRIPT)
    try {
      if (fs.statSync(file).isFile()) return { file, dataDir }
    } catch {
      /* not in this product's data dir */
    }
  }
  return null
}

/**
 * The conversation a transcript path belongs to (its folder name), or null if
 * the path is not a transcript's. `anyParent`: for a path already resolved
 * through links — the conversation's folder may then sit in a folder of any
 * name (a `brain` moved to another disk and linked back).
 */
export function conversationOfPath(file, { anyParent = false } = {}) {
  const parts = path.resolve(file).split(path.sep)
  const n = parts.length
  if (n < 6 || parts[n - 1] !== TRANSCRIPT[2] || parts[n - 2] !== TRANSCRIPT[1] || parts[n - 3] !== TRANSCRIPT[0]) return null
  return (anyParent || parts[n - 5] === "brain") && isConversationId(parts[n - 4]) ? parts[n - 4] : null
}

/** Which Antigravity product wrote under this data dir. */
export function surfaceOf(dataDir) {
  const name = path.basename(dataDir ?? "")
  return name === "antigravity" ? "app" : name === "antigravity-cli" ? "cli" : name === "antigravity-ide" ? "ide" : "unknown"
}

/**
 * The transcript as it is uploaded: every complete line of it, as written.
 * Antigravity rewrites the file while the session runs, so its last line can be
 * half written — a line with no newline after it is left out, never repaired.
 */
export function snapshotOf(raw) {
  if (raw === "" || raw.endsWith("\n")) return raw
  const cut = raw.lastIndexOf("\n")
  return cut === -1 ? "" : raw.slice(0, cut + 1)
}

/** What `prepare` reports about a transcript: its steps, and whether a person has said anything in it. */
export function describeTranscript(jsonl) {
  let steps = 0
  let userInputs = 0
  for (const line of jsonl.split("\n")) {
    const s = line.trim()
    if (!s) continue
    let rec
    try {
      rec = JSON.parse(s)
    } catch {
      continue
    }
    if (!isObj(rec) || typeof rec.type !== "string" || typeof rec.source !== "string") continue
    steps++
    if (rec.type === "USER_INPUT") userInputs++
  }
  return { steps, userInputs }
}

const CLIENT = "ef-share-antigravity"

/**
 * The record a snapshot begins with: what the transcript itself does not say.
 * `conversation_id` is how the server knows a later upload is the same session.
 */
export function sessionHeader({ conversationId, surface, cwd, antigravityVersion, clientVersion }) {
  return JSON.stringify({
    type: "ef_share",
    payload: {
      event: "session",
      runtime: "antigravity",
      conversation_id: conversationId,
      surface: surface ?? "unknown",
      cwd: cwd ?? null,
      antigravity_version: antigravityVersion ?? null,
      client: CLIENT,
      client_version: clientVersion ?? null,
    },
  })
}

/** The conversation id a snapshot's first record names, or null. */
export function snapshotConversationId(jsonl) {
  const first = jsonl.slice(0, jsonl.indexOf("\n") === -1 ? jsonl.length : jsonl.indexOf("\n"))
  try {
    const rec = JSON.parse(first)
    const p = isObj(rec) && rec.type === "ef_share" && isObj(rec.payload) ? rec.payload : null
    return p && p.event === "session" && p.runtime === "antigravity" && isConversationId(p.conversation_id) ? p.conversation_id : null
  } catch {
    return null
  }
}

/**
 * The folder the session ran in, as the snapshot's first record says it — the
 * folder `prepare` was run from, inside the conversation. A page the server
 * names (ADR-0033) is listed only when it is a file inside it. A snapshot taken
 * from a terminal says none: the transcript itself holds no folder.
 */
export function sessionFolders(jsonl) {
  const first = jsonl.slice(0, jsonl.indexOf("\n") === -1 ? jsonl.length : jsonl.indexOf("\n"))
  try {
    const rec = JSON.parse(first)
    const p = isObj(rec) && rec.type === "ef_share" && isObj(rec.payload) && rec.payload.event === "session" ? rec.payload : null
    return p && typeof p.cwd === "string" && path.isAbsolute(p.cwd) ? [p.cwd] : []
  } catch {
    return []
  }
}

/**
 * The record `prepare` appends to a snapshot taken from inside the session being
 * published: "the publish of this session starts here". It is how the server
 * knows that the last turn asked for the publish, and keeps that turn off the
 * page.
 */
export function publishMarker(clientVersion) {
  return JSON.stringify({
    type: "ef_share",
    payload: { event: "publish_started", client: CLIENT, client_version: clientVersion ?? null },
  })
}
