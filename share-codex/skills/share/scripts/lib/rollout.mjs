// Locating and slimming a Codex rollout (the JSONL transcript Codex CLI and the
// Codex desktop app write under $CODEX_HOME/sessions/YYYY/MM/DD/).
//
// Slimming keeps what ElasticFlow Share shows — the thread items, the turn model
// and token usage — and leaves out what Codex adds for the model and for itself:
// the base instructions, developer messages, the copy of AGENTS.md it injects,
// the tool catalogue, encrypted reasoning, account ids and rate-limit balances.
// What a command printed is part of the session and is kept as recorded.
//
// Shapes measured on Codex CLI 0.167.0 rollouts, 2026-11-18.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** User-role content Codex injects itself (never typed by the person). */
const INJECTED_USER_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "# AGENTS.md instructions",
  "<turn_aborted>",
  "<subagent_notification>",
  "<user_shell_command>",
  "<skill>",
  "<system_reminder>",
  "<collaboration_mode>",
  "<permissions instructions>",
]

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

function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k]
  return out
}

function slimSessionMeta(p) {
  const out = pick(p, ["id", "session_id", "timestamp", "cwd", "originator", "cli_version", "source", "thread_source", "model_provider", "history_mode"])
  if (isObj(p.git) && typeof p.git.branch === "string") out.git = { branch: p.git.branch }
  return out
}

/** A skill the person invoked by name: Codex adds its SKILL.md as a `<skill>` user-role part. */
const isSkillPart = (c) => isObj(c) && typeof c.text === "string" && c.text.trimStart().startsWith("<skill>")

/**
 * A user message reduced to what is published: the skills invoked by name and,
 * for legacy history (`withText`), the parts the person typed. Null when nothing
 * of it is.
 */
function slimUserMessage(p, withText) {
  const content = Array.isArray(p.content) ? p.content : []
  const meta = p.internal_chat_message_metadata_passthrough
  const kinds = isObj(meta) && Array.isArray(meta.content_item_kinds) ? meta.content_item_kinds : null
  const kept = content.filter((c, i) => {
    if (!isObj(c) || typeof c.text !== "string") return false
    if (isSkillPart(c)) return true
    if (!withText) return false
    if (kinds && kinds.length === content.length) return kinds[i] === "user.text"
    return !INJECTED_USER_PREFIXES.some((pre) => c.text.trimStart().startsWith(pre))
  })
  if (kept.length === 0) return null
  const out = { type: "message", role: "user", ...(p.id ? { id: p.id } : {}), content: kept.map((c) => ({ type: c.type, text: c.text })) }
  // Keep the kinds of the kept parts: without them the server falls back to
  // guessing injected context by its prefix, and would drop a typed message
  // that happens to start with one.
  if (kinds && kinds.length === content.length) {
    out.internal_chat_message_metadata_passthrough = {
      content_item_kinds: content.map((c, i) => (kept.includes(c) ? kinds[i] : null)).filter((k) => k !== null),
    }
  }
  return out
}

/** A response item worth keeping when the rollout has no thread items (legacy history). */
function slimResponseItem(p) {
  switch (p.type) {
    case "message":
      if (p.role === "user") return slimUserMessage(p, true)
      if (p.role === "assistant") return pick(p, ["type", "role", "id", "phase", "content"])
      return null
    case "reasoning": {
      const summary = Array.isArray(p.summary) ? p.summary : []
      if (summary.length === 0) return null
      return { type: "reasoning", ...(p.id ? { id: p.id } : {}), summary }
    }
    case "function_call":
      return pick(p, ["type", "id", "name", "arguments", "call_id"])
    case "custom_tool_call":
      return pick(p, ["type", "id", "name", "input", "call_id"])
    case "function_call_output":
    case "custom_tool_call_output":
      return pick(p, ["type", "id", "call_id", "output"])
    case "local_shell_call":
      return pick(p, ["type", "id", "call_id", "action", "status"])
    case "web_search_call":
      return pick(p, ["type", "id", "action", "status"])
    default:
      return null
  }
}

/**
 * The fields of each thread item kind that a reader sees (measured on Codex
 * 0.167–0.170). A known kind is cut to them, so a field Codex adds to it later
 * is not uploaded unseen. A kind this list does not know is uploaded as its
 * name alone — the page shows that a step happened; what it held is unknown, so
 * whether it is for a reader is unknown too.
 */
const ITEM_FIELDS = {
  UserMessage: ["content"],
  AgentMessage: ["content", "phase"],
  Reasoning: ["summary_text", "raw_content"],
  CommandExecution: ["command", "cwd", "parsed_cmd", "status", "aggregated_output", "exit_code"],
  HookPrompt: [], // context a hook added for the model — never published
  FileChange: ["changes", "status", "stdout", "stderr"],
  McpToolCall: ["server", "tool", "arguments", "status", "result", "error"],
  WebSearch: ["query", "action", "results", "status"],
  Extension: ["kind", "query", "action", "results", "status"],
  ContextCompaction: [],
}

const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/

/** The ticket of a Share `share_begin` answer (`{ stagingId, uploadUrl, ticket }`), else null. */
function ticketOf(answer) {
  let a = answer
  if (typeof a === "string") {
    try {
      a = JSON.parse(a)
    } catch {
      return null
    }
  }
  if (!isObj(a) || typeof a.stagingId !== "string" || typeof a.uploadUrl !== "string") return null
  return typeof a.ticket === "string" && JWT.test(a.ticket) ? a.ticket : null
}

/**
 * The upload tickets earlier publishes of this session were given: the `ticket`
 * of every Share `share_begin` answer in the rollout. A ticket is single-use and
 * spent, but it is a credential-shaped string — a later publish would upload it
 * and the server would report it as an unredacted secret. Collected by VALUE, so
 * it can be masked wherever the flow left it (the answer, the `--ticket`
 * argument, an environment assignment) and nothing that merely looks like one is
 * touched.
 */
function spentUploadTickets(parsed) {
  const tickets = new Set()
  const add = (v) => {
    const t = ticketOf(v)
    if (t) tickets.add(t)
  }
  const shareBeginCalls = new Set()
  for (const { rec } of parsed) {
    const p = rec.payload
    if (rec.type === "event_msg" && p.type === "item_completed" && isObj(p.item) && p.item.type === "McpToolCall" && p.item.tool === "share_begin") {
      const result = p.item.result
      if (isObj(result)) {
        add(result.structuredContent)
        for (const c of Array.isArray(result.content) ? result.content : []) if (isObj(c)) add(c.text)
      }
    } else if (rec.type === "response_item") {
      // legacy history: the call names the tool, its output carries the answer
      if (p.type === "function_call" && typeof p.name === "string" && /(?:^|__)share_begin$/.test(p.name)) shareBeginCalls.add(p.call_id)
      else if (p.type === "function_call_output" && shareBeginCalls.has(p.call_id)) {
        add(p.output)
        if (isObj(p.output)) add(p.output.content)
        for (const c of Array.isArray(p.output) ? p.output : []) if (isObj(c)) add(c.text)
      }
    }
  }
  return tickets
}

function slimItem(item) {
  // Only the web-search extension has a known shape; other extension kinds are unknown kinds.
  const fields = item.type === "Extension" && item.kind !== "web.search" ? ["kind", "status"] : ITEM_FIELDS[item.type] ?? ["status"]
  return { type: item.type, ...(item.id !== undefined ? { id: item.id } : {}), ...pick(item, fields) }
}

function slimEvent(p) {
  switch (p.type) {
    case "item_completed":
      return isObj(p.item) ? { ...pick(p, ["type", "turn_id", "started_at_ms", "completed_at_ms"]), item: slimItem(p.item) } : null
    case "task_started":
      return pick(p, ["type", "turn_id", "started_at"])
    case "task_complete":
      return pick(p, ["type", "turn_id", "started_at", "completed_at", "duration_ms"])
    case "turn_aborted":
      return pick(p, ["type", "turn_id", "reason"])
    case "context_compacted":
      return { type: "context_compacted" }
    default:
      return null
  }
}

/**
 * Slim a rollout. Returns the JSONL to upload plus counts. Every kept record
 * carries `ordinal` — Codex's own, or the record's line number in the source —
 * so the server's fallback record ids do not move when lines are dropped.
 */
export function slimRollout(jsonl) {
  const parsed = []
  const lines = jsonl.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (!s) continue
    try {
      const rec = JSON.parse(s)
      if (isObj(rec) && isObj(rec.payload)) parsed.push({ rec, line: i })
    } catch {
      /* a torn last line of a live rollout — skip */
    }
  }
  const hasUsageRecords = parsed.some(({ rec }) => rec.type === "token_usage_record")
  // A session begun on a Codex without thread items and continued on one with
  // them: the turns before the first thread item keep their response items, every
  // later turn its thread items (the server reads it the same way). Turns are
  // delimited by `task_started`.
  const turnOf = []
  let firstItemTurn = Infinity
  let turn = 0
  for (const { rec } of parsed) {
    const kind = rec.type === "event_msg" ? rec.payload.type : null
    if (kind === "task_started") turn++
    if (kind === "item_completed" && turn < firstItemTurn) firstItemTurn = turn
    turnOf.push(turn)
  }
  const hasItems = firstItemTurn !== Infinity

  const out = []
  let meta = null
  parsed.forEach(({ rec, line }, index) => {
    const p = rec.payload
    let payload = null
    switch (rec.type) {
      case "session_meta":
        payload = slimSessionMeta(p)
        meta = meta ?? payload
        break
      case "turn_context":
        payload = pick(p, ["turn_id", "cwd", "model", "effort"])
        break
      case "token_usage_record":
        payload = isObj(p.usage) ? pick(p, ["turn_id", "usage"]) : null
        break
      case "compacted":
        payload = {}
        break
      case "response_item":
        // In a turn with thread items the response items are the model-facing copy —
        // all but the skills invoked by name, which exist nowhere else.
        if (turnOf[index] < firstItemTurn) payload = slimResponseItem(p)
        else payload = p.type === "message" && p.role === "user" ? slimUserMessage(p, false) : null
        break
      case "event_msg":
        if (p.type === "token_count") {
          const last = isObj(p.info) ? p.info.last_token_usage : null
          payload = !hasUsageRecords && isObj(last) ? { type: "token_count", info: { last_token_usage: last } } : null
        } else {
          payload = slimEvent(p)
        }
        break
      default:
        payload = null // world_state, future record kinds: not needed to show the session
    }
    if (payload === null) return
    out.push({
      timestamp: rec.timestamp ?? null,
      ordinal: typeof rec.ordinal === "number" ? rec.ordinal : line,
      type: rec.type,
      payload,
    })
  })

  // A ticket is base64url text, so it sits in the serialized records verbatim.
  let slimmed = out.map((r) => JSON.stringify(r)).join("\n") + (out.length ? "\n" : "")
  for (const ticket of spentUploadTickets(parsed)) slimmed = slimmed.split(ticket).join("[upload-ticket]")
  return {
    jsonl: slimmed,
    meta,
    recordsIn: parsed.length,
    recordsOut: out.length,
    /** records that carry conversation: thread items, or legacy response items */
    contentRecords: out.filter(
      (r) => r.type === "response_item" || (r.type === "event_msg" && r.payload.type === "item_completed"),
    ).length,
    historyMode: hasItems ? "paginated" : "legacy",
  }
}

/** The thread id recorded in a rollout's first `session_meta` record, or null. */
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
export function publishMarker(slimJsonl, clientVersion) {
  let last = -1
  for (const line of slimJsonl.split("\n")) {
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
