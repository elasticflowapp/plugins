// The ticketed transcript upload and what the skill shows of its answer.

import fs from "node:fs"

/**
 * The upload goes only to ElasticFlow Share: an `elasticflow.app` host over
 * HTTPS, or a loopback address for local development. A ticket and a transcript
 * are never sent anywhere a tool result or a page happened to name.
 */
export function isShareUploadUrl(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.username || u.password) return false
  if (!/\/upload\/?$/.test(u.pathname)) return false
  const host = u.hostname.toLowerCase()
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]"
  if (loopback) return u.protocol === "http:" || u.protocol === "https:"
  if (u.protocol !== "https:") return false
  return host === "elasticflow.app" || host.endsWith(".elasticflow.app")
}

/** Why a request did not get an answer, in words (Node's `fetch failed` hides it in `cause`). */
function networkReason(e) {
  const cause = e?.cause
  const detail = cause?.code ?? cause?.message ?? e?.message ?? String(e)
  return (
    `could not reach the upload address (${detail}). If the sandbox blocks network access, ` +
    `this command needs approval to use the network.`
  )
}

/**
 * POST the snapshot as the `session.jsonl` form field. Returns the server's
 * answer, which must be the Codex-aware one (`runtime: "codex"`): a server
 * that does not read Codex rollouts would otherwise publish an empty session.
 */
export async function uploadSnapshot({ snapshotPath, url, ticket, fetchImpl = fetch }) {
  if (!isShareUploadUrl(url)) {
    throw new Error(`refusing to upload: ${url} is not an ElasticFlow Share upload address`)
  }
  if (!ticket) throw new Error("missing upload ticket (call share_begin first)")
  const body = fs.readFileSync(snapshotPath)
  const form = new FormData()
  form.append("session.jsonl", new Blob([body], { type: "application/jsonl" }), "session.jsonl")
  let res
  try {
    // A redirect is never followed: the address was checked, its target was not,
    // and the ticket and the transcript must not travel on to it.
    res = await fetchImpl(url, { method: "POST", headers: { "X-Upload-Ticket": ticket }, body: form, redirect: "manual" })
  } catch (e) {
    throw new Error(`upload failed: ${networkReason(e)}`)
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new Error(`upload refused: ${url} answered with a redirect, which is not followed`)
  }
  const text = await res.text()
  if (!res.ok) {
    const hint =
      res.status === 401
        ? " — the ticket is single-use and short-lived; call share_begin again for a fresh one"
        : res.status === 413
          ? " — this session's record is larger than the server accepts in one upload"
          : ""
    throw new Error(`upload failed: HTTP ${res.status} ${text.slice(0, 300)}${hint}`)
  }
  let answer
  try {
    answer = JSON.parse(text)
  } catch {
    throw new Error(`upload answered with something that is not JSON: ${text.slice(0, 200)}`)
  }
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    throw new Error(`upload answered with something unexpected: ${text.slice(0, 200)}`)
  }
  if (answer.runtime !== "codex") {
    throw new Error(
      "this ElasticFlow Share server did not recognise the upload as a Codex session " +
        `(runtime: ${JSON.stringify(answer.runtime ?? null)}). Not publishing — the server needs the Codex adapter.`,
    )
  }
  return answer
}

/**
 * Redaction candidates grouped by what was found, so the person decides per
 * finding ("that key", "every email") and not per occurrence. Group numbers
 * belong to ONE upload answer: another upload numbers its groups afresh.
 */
export function groupCandidates(candidates) {
  const groups = new Map()
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (c === null || typeof c !== "object") continue
    const key = `${c.severity}\u0000${c.kind}\u0000${c.text_preview}`
    let g = groups.get(key)
    if (!g) {
      g = { group: 0, severity: c.severity, kind: c.kind, preview: c.text_preview, count: 0, spans: [] }
      groups.set(key, g)
    }
    g.count++
    g.spans.push({
      turn_idx: c.turn_idx,
      block_idx: c.block_idx,
      path: c.path,
      span_start: c.span_start,
      span_end: c.span_end,
      replacement: c.replacement ?? "[redacted]",
    })
  }
  const rank = (g) => (g.severity === "secret" ? 0 : 1)
  const list = [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.count - a.count)
  list.forEach((g, i) => (g.group = i + 1))
  return list
}

/**
 * The `redactions` array for share_publish from a selection. A selection is
 * `none`, or a comma list of any of: `all`, `secrets`, a group number, a kind
 * (`email`). Every part must name something — a selection that cannot be
 * honoured in full is an error, never a shorter list.
 */
export function selectRedactions(groups, selection) {
  if (typeof selection !== "string" || !selection.trim()) {
    throw new Error("no selection given: use --select none, or name what to redact (all, secrets, group numbers, kinds)")
  }
  const parts = selection.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) throw new Error("empty selection: use --select none to redact nothing")
  if (parts.includes("none")) {
    if (parts.length > 1) throw new Error('"none" cannot be combined with other selections')
    return []
  }
  const kinds = new Set(groups.map((g) => String(g.kind).toLowerCase()))
  const chosen = new Set()
  for (const part of parts) {
    let hits
    if (part === "all") hits = groups
    else if (part === "secrets") hits = groups.filter((g) => g.severity === "secret")
    else if (/^\d+$/.test(part)) hits = groups.filter((g) => g.group === Number(part))
    else hits = groups.filter((g) => String(g.kind).toLowerCase() === part)
    // `all` and `secrets` may match nothing (a session with no findings); a number
    // or a kind that matches nothing is a mistake.
    if (hits.length === 0 && part !== "all" && part !== "secrets") {
      const valid = ["none", "all", "secrets", ...groups.map((g) => String(g.group)), ...kinds].join(", ")
      throw new Error(`"${part}" matches no redaction group. Valid here: ${valid}`)
    }
    for (const g of hits) chosen.add(g)
  }
  const spans = []
  for (const g of groups) if (chosen.has(g)) spans.push(...g.spans)
  return spans
}
