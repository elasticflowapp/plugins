// Locating a Codex rollout (the JSONL record Codex CLI and the Codex desktop app
// write under $CODEX_HOME/sessions/YYYY/MM/DD/) and taking the snapshot that is
// uploaded.
//
// The snapshot is the rollout as Codex recorded it, with three things taken out
// that stay on this machine: Codex's own instructions to the model, the Codex
// account ids, and the account's usage limits. Everything else is uploaded as
// written; what of it is shown on the page, and what is never stored, is decided
// by the server, so something the page starts to use tomorrow is already in the
// upload.
//
// Why those three: Codex will not hand them over. Told that the upload held its
// instructions and account metadata, Codex 0.170 (gpt-6.2-sol) refused to publish
// — 3 of 3 on 2026-11-19; with them kept here it published.
//
// Where they sit, measured on twelve real rollouts of Codex 0.167–0.170
// (2026-11-19): `session_meta.base_instructions`, `creator_user_id`,
// `creator_account_id`; every `response_item` of role `developer` (messages and
// the tool catalogue); `developer_instructions` under `collaboration_mode.settings`
// in `turn_context` and in `thread_settings_applied`; the `instructions` of the
// model, the permissions and the collaboration mode in `world_state`;
// `token_count.rate_limits` (the plan among them). They are removed by KIND of
// field wherever Codex's bookkeeping holds one, not at those paths only.
//
// Codex keeps a second copy of what it tells the model in its state record, under
// names that do not say "instructions" — measured on 24 real rollouts of Codex
// 0.167–0.171 (2026-11-23), after 0.2.0 had uploaded them: `world_state.state.tools`
// and `.top_level_tools` (the tool catalogue: every tool's name with its
// description) and `.host_skills` (`body`: the text of the skills listing Codex
// hands the model). They stay here too. The recordings the first measurement was
// checked against had their state blanked, which is how these were missed.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

export function codexHome(env = process.env) {
  return env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME : path.join(os.homedir(), ".codex")
}

export function isThreadId(id) {
  return typeof id === "string" && THREAD_ID.test(id)
}

/** Every file under `dir` whose name ends with `-<threadId>.jsonl` (bounded walk). */
function findIn(dir, threadId, depth, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (depth > 0) findIn(p, threadId, depth - 1, out)
    } else if (e.name.startsWith("rollout-") && e.name.endsWith(`-${threadId}.jsonl`)) {
      out.push(p)
    }
  }
}

/**
 * The rollout file of one thread, or null. Codex names it
 * `rollout-<timestamp>-<thread id>.jsonl`, so the id alone identifies it — no
 * "newest file" guess, which is how the wrong session gets published.
 */
export function findRollout(threadId, home = codexHome()) {
  if (!isThreadId(threadId)) return null
  const hits = []
  findIn(path.join(home, "sessions"), threadId, 3, hits)
  findIn(path.join(home, "archived_sessions"), threadId, 3, hits)
  if (hits.length === 0) return null
  hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return hits[0]
}

/** Roles through which Codex instructs the model. */
const INSTRUCTING_ROLE = new Set(["developer", "system"])
/** A field that holds instructions for the model, whatever it is called (`base_instructions`, `developer_instructions`, `instructions` …). */
const INSTRUCTIONS_KEY = /instructions/i
/** A field of Codex's own state that is the tool catalogue or the skills listing it hands the model. */
const CATALOGUE_KEY = /^(?:tools|top_level_tools|host_skills)$/
/** A field that names the account: its ids, an address, its plan and limits. */
const ACCOUNT_KEY = /(?:^|_)(?:user|account|org|organization|workspace)_id$|^(?:account|accountId|userId|auth)$|email|^rate_limits?$|plan_type/i

/** A message (or any object) spoken in an instructing role. */
const instructs = (v) => isObj(v) && typeof v.role === "string" && INSTRUCTING_ROLE.has(v.role)

/**
 * A value of Codex's bookkeeping without what stays on this machine: no field
 * of instructions, no tool catalogue or skills listing, no account field, no
 * instructing message — at any depth.
 * Returns the SAME value when nothing was taken out.
 */
function withoutLocalOnly(value) {
  if (Array.isArray(value)) {
    let changed = false
    const out = []
    for (const v of value) {
      if (instructs(v)) {
        changed = true
        continue
      }
      const kept = withoutLocalOnly(v)
      if (kept !== v) changed = true
      out.push(kept)
    }
    return changed ? out : value
  }
  if (!isObj(value)) return value
  let changed = false
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (INSTRUCTIONS_KEY.test(k) || CATALOGUE_KEY.test(k) || ACCOUNT_KEY.test(k)) {
      changed = true
      continue
    }
    const kept = withoutLocalOnly(v)
    if (kept !== v) changed = true
    out[k] = kept
  }
  return changed ? out : value
}

/**
 * What stays on this machine, for one record. Returns the record to upload —
 * the same object when nothing is taken out — or null to leave the record out.
 *
 * Two kinds of record are never looked into — a completed thread item
 * (`event_msg` / `item_completed`) and a response item of the person or the
 * agent: a tool call's own argument named `instructions` or `email` there is
 * the session's work, not Codex's bookkeeping. Every other record is Codex's
 * own bookkeeping and is filtered by the kind of its fields, at any depth —
 * the other `event_msg` records included, so a field of theirs with one of
 * these names is left out even where it repeats something from the session.
 */
function recordToUpload(rec) {
  const p = rec.payload
  if (!isObj(p)) return rec
  if (rec.type === "response_item") return instructs(p) ? null : rec
  if (rec.type === "event_msg" && p.type === "item_completed") return rec
  const kept = withoutLocalOnly(p)
  return kept === p ? rec : { ...rec, payload: kept }
}

/**
 * The rollout as it is uploaded: every complete record of it, as written —
 * except what stays on this machine. A record nothing is taken from is passed
 * byte for byte. A line that is not a record (not a JSON object, even with the
 * white space around it trimmed) is left out: it cannot be looked into, so it
 * cannot be vouched for. Codex appends to the file while the session runs, so
 * its last line can be half written — a line with no newline after it is left
 * out, never repaired.
 */
export function snapshotOf(raw) {
  const cut = raw === "" || raw.endsWith("\n") ? raw.length : raw.lastIndexOf("\n") + 1
  const out = []
  for (const line of raw.slice(0, cut).split("\n")) {
    const text = line.trim() // also a byte-order mark, a form feed, a no-break space
    if (!text) continue
    let rec
    try {
      rec = JSON.parse(text)
    } catch {
      continue
    }
    if (!isObj(rec)) continue
    const kept = recordToUpload(rec)
    if (kept === null) continue
    out.push(kept === rec ? text : JSON.stringify(kept))
  }
  return out.length ? out.join("\n") + "\n" : ""
}

/**
 * What `prepare` reports about a snapshot. `contentRecords` counts the records
 * that can carry conversation (thread items, response items): zero means there
 * is nothing to publish yet. Whether those records hold anything a reader will
 * see is the server's answer, not this count's.
 */
export function describeRollout(jsonl) {
  let meta = null
  let records = 0
  let contentRecords = 0
  for (const line of jsonl.split("\n")) {
    const s = line.trim()
    if (!s) continue
    let rec
    try {
      rec = JSON.parse(s)
    } catch {
      continue
    }
    if (!isObj(rec) || !isObj(rec.payload)) continue
    records++
    if (rec.type === "session_meta") meta = meta ?? rec.payload
    else if (rec.type === "response_item" || (rec.type === "event_msg" && rec.payload.type === "item_completed")) contentRecords++
  }
  return {
    cliVersion: typeof meta?.cli_version === "string" ? meta.cli_version : null,
    originator: typeof meta?.originator === "string" ? meta.originator : null,
    records,
    contentRecords,
  }
}

export function rolloutThreadId(jsonl) {
  for (const line of jsonl.split("\n")) {
    const s = line.trim()
    if (!s) continue
    try {
      const rec = JSON.parse(s)
      if (isObj(rec) && rec.type === "session_meta" && isObj(rec.payload)) {
        return isThreadId(rec.payload.id) ? rec.payload.id : null
      }
    } catch {
      return null
    }
    return null
  }
  return null
}

/**
 * The record `prepare` appends to a snapshot taken from inside the session being
 * published: "the publish of this session starts here". Codex writes a step to
 * the rollout only when it completes, so the snapshot of a first publish holds
 * nothing of the publishing flow — this is how the server knows that the last
 * turn asked for it, and keeps that turn off the page.
 */
export function publishMarker(jsonl, clientVersion) {
  let last = -1
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue
    try {
      const ordinal = JSON.parse(line).ordinal
      if (typeof ordinal === "number" && ordinal > last) last = ordinal
    } catch {
      /* not ours to fix */
    }
  }
  return JSON.stringify({
    timestamp: null,
    ordinal: last + 1,
    type: "ef_share",
    payload: { event: "publish_started", client: "ef-share-codex", client_version: clientVersion ?? null },
  })
}
