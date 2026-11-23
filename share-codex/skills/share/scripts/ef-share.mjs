#!/usr/bin/env node
// ef-share for Codex — the local half of publishing a Codex session to
// ElasticFlow Share. The `share` skill drives it:
//
//   prepare       find THIS session's rollout, write the snapshot of it that is uploaded
//   upload        send the snapshot with the single-use ticket from share_begin; list the
//                 pages the session wrote that could be published as results
//   results       list them again, with a page the person named
//   send-results  send the snapshot again, with the results the person chose
//   redactions    turn the person's redaction choice into the share_publish array
//   provenance    where the session's skills and plugins come from (best effort)
//   clean         remove the snapshot and what was stored beside it
//
// No dependencies; needs Node 18+.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { codexHome, describeRollout, findRollout, isThreadId, publishMarker, rolloutThreadId, sessionFolders, snapshotOf } from "./lib/rollout.mjs"
import { groupCandidates, selectRedactions, uploadSnapshot } from "./lib/upload.mjs"
import {
  VERIFY_LIMIT_MS, bounded, listId, listResultsBounded, pagesFromAnswer, parseResultSelection, planResultsUploadFitting, readListing, resultsForDisplay, roomForResults,
  sha256Hex, takeResultPreviews, writeListing,
} from "./lib/results.mjs"
import { extractProvenance } from "./lib/provenance.mjs"

const WORK_PREFIX = "ef-share-codex-"

/** The plugin's version, from its manifest three folders up; null for a skill copied out of the plugin. */
function clientVersion() {
  try {
    const manifest = new URL("../../../.codex-plugin/plugin.json", import.meta.url)
    const version = JSON.parse(fs.readFileSync(manifest, "utf8")).version
    return typeof version === "string" ? version : null
  } catch {
    return null
  }
}

const COMMANDS = {
  prepare: ["thread", "rollout", "out"],
  upload: ["snapshot", "url", "ticket"],
  results: ["snapshot", "result"],
  "send-results": ["snapshot", "url", "ticket", "results", "list", "pictures"],
  redactions: ["response", "select"],
  provenance: ["snapshot"],
  clean: ["snapshot"],
}
/** The one option that may be given more than once: a page the person names, once per page. */
const REPEATABLE = new Set(["result"])

function fail(message, code = 1) {
  process.stderr.write(`ef-share: ${message}\n`)
  process.exit(code)
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n")
}

/**
 * `--name value` and `--name=value`. A flag the command does not take, a flag
 * without a value, or a stray word is an error — a mistyped option must never
 * be read as "use the default".
 */
function flags(command, argv) {
  const allowed = COMMANDS[command]
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) fail(`unexpected argument "${a}" for ${command}`, 2)
    const eq = a.indexOf("=")
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq)
    if (!allowed.includes(key)) fail(`${command} takes no --${key} option (it takes: ${allowed.map((k) => `--${k}`).join(", ")})`, 2)
    let value
    if (eq !== -1) value = a.slice(eq + 1)
    // the next word is this flag's value only if it is not itself a flag
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i]
    if (value === undefined || value === "") fail(`--${key} needs a value`, 2)
    if (REPEATABLE.has(key)) {
      ;(out[key] ??= []).push(value)
      continue
    }
    if (key in out) fail(`--${key} is given twice`, 2)
    out[key] = value
  }
  return out
}

function readText(file, what) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (e) {
    fail(`cannot read ${what} ${file}: ${e.message}`, 2)
  }
}

/**
 * The work folder: a fresh unguessable private (0700) one under the temp dir, or
 * the one named with --out — created private if it is not there, left as it is
 * if it is (the snapshot inside is 0600 either way).
 */
function workDir(f) {
  try {
    if (f.out) {
      fs.mkdirSync(f.out, { recursive: true, mode: 0o700 })
      return f.out
    }
    return fs.mkdtempSync(path.join(os.tmpdir(), WORK_PREFIX))
  } catch (e) {
    fail(`cannot create the work folder: ${e.message}`, 2)
  }
}

function prepare(f) {
  // set but empty is not "outside a session": something cleared it, and guessing which session is meant is not ours to do
  if (process.env.CODEX_THREAD_ID === "") fail("CODEX_THREAD_ID is set but empty. Not publishing.", 2)
  const current = process.env.CODEX_THREAD_ID ?? null
  if (current && !isThreadId(current)) fail(`CODEX_THREAD_ID "${current}" is not a Codex session id. Not publishing.`, 2)
  // Inside a Codex session the session is the one running — an option cannot name
  // another. --thread / --rollout exist for a person publishing from a terminal.
  if (current && f.thread && f.thread !== current) {
    fail(`this is session ${current}; --thread names ${f.thread}. Not publishing another session from inside this one.`, 2)
  }
  const threadId = current ?? f.thread ?? null
  if (threadId && !isThreadId(threadId)) fail(`"${threadId}" is not a Codex session id`, 2)

  let rollout = f.rollout ?? null
  if (!rollout) {
    if (!threadId) fail("couldn't resolve the current Codex session: CODEX_THREAD_ID is not set in this shell. Not publishing.", 2)
    rollout = findRollout(threadId)
    if (!rollout) fail(`no rollout file for session ${threadId} under ${codexHome()} (sessions/, archived_sessions/). Not publishing.`, 2)
  }
  const raw = readText(rollout, "the rollout")
  const recorded = rolloutThreadId(raw)
  if (!recorded) fail(`${rollout} is not a Codex rollout (no session_meta record with a session id). Not publishing.`, 2)
  if (threadId && recorded !== threadId) fail(`${rollout} belongs to session ${recorded}, not ${threadId}. Not publishing.`, 2)

  // The record as Codex wrote it, less what stays on this machine (Codex's own
  // instructions, the account ids and limits): what of it is shown, and what is
  // never stored, is the server's to decide.
  const whole = snapshotOf(raw)
  const info = describeRollout(whole)
  if (info.contentRecords === 0) fail("this session has no messages or tool calls to publish yet", 2)
  // From inside the session, the publish starts where the snapshot ends; a
  // session published from a terminal later has no such point.
  const inSession = current !== null && recorded === current
  const body = inSession ? whole + publishMarker(whole, clientVersion()) + "\n" : whole
  const snapshot = path.join(workDir(f), `${recorded}.rollout.jsonl`)
  try {
    // what an earlier publish kept beside a snapshot of this name (a folder given with --out is used again):
    // its answer, its list of results and its pictures are about another snapshot
    removeBeside(snapshot)
    // "wx": never write through a file or link someone left at this path
    fs.rmSync(snapshot, { force: true })
    fs.writeFileSync(snapshot, body, { mode: 0o600, flag: "wx" })
  } catch (e) {
    fail(`cannot write the snapshot: ${e.message}`, 2)
  }
  print({
    snapshot,
    thread_id: recorded,
    cli_version: info.cliVersion,
    originator: info.originator,
    // of the snapshot as written: the marker, when there is one, is its last record
    records: info.records + (inSession ? 1 : 0),
    bytes: Buffer.byteLength(body),
  })
}

const SNAPSHOT_SUFFIX = ".rollout.jsonl"

function responseFileFor(snapshot) {
  return snapshot.slice(0, -SNAPSHOT_SUFFIX.length) + ".upload.json"
}

/** The list of results shown to the person, kept beside the snapshot: `send-results` sends what was listed. */
function listingFileFor(snapshot) {
  return snapshot.slice(0, -SNAPSHOT_SUFFIX.length) + ".results.json"
}

/** Where the preview picture of result `id` is written. */
function pictureFileFor(snapshot, id) {
  return snapshot.slice(0, -SNAPSHOT_SUFFIX.length) + `.preview.${id}.png`
}

/** The name of a preview picture `send-results` wrote for the snapshot `<id>.rollout.jsonl`. */
const pictureName = (id) => new RegExp(`^${id}\\.preview\\.\\d{1,3}\\.png$`)

/**
 * The pages that could be published as results, listed and written beside the
 * snapshot: those the server named in its answer that are files in the
 * session's own folders, and those the person named — now, or for an earlier
 * list of this same snapshot. Never fails the command it is part of — an upload
 * that has been taken stays taken.
 *
 * `results_list` is the id of this list: a yes is a yes to one list, and
 * `send-results` takes the id of the list the person answered.
 */
async function listPages(snapshot, text, answer, named = []) {
  try {
    const fromServer = pagesFromAnswer(answer)
    const digest = sha256Hex(Buffer.from(text))
    const file = listingFileFor(snapshot)
    const previous = readListing(file, digest)?.results ?? []
    // each page is read in a worker that is ended at its limit: one can keep the reading busy for minutes
    const { results, notes } = await listResultsBounded({ pages: fromServer.pages, folders: sessionFolders(text), named, cwd: process.cwd(), previous })
    if (!fromServer.known) notes.unshift('this server does not name the pages a session wrote: a page is listed only when it is named — results --snapshot "<snapshot>" --result "<path>"')
    if (fromServer.unusable > 0) notes.push(`${fromServer.unusable} name(s) in the server's list were not plain paths to a page and were left out`)
    if (fromServer.more > 0) notes.push(`the session wrote ${fromServer.more} more page(s) than the server names (it names the most recent) — name one with --result "<path>" to list it`)
    writeListing(file, results, digest)
    return { results_file: file, results_list: results.length > 0 ? listId(results) : null, results: resultsForDisplay(results, roomForResults(Buffer.from(text))), result_notes: notes }
  } catch (e) {
    return { results_file: null, results_list: null, results: [], result_notes: [`the pages the session wrote could not be listed: ${e.message}`] }
  }
}

/**
 * Remove what is kept beside a snapshot — the stored upload answer, the list of
 * results, the preview pictures — and say which files went. Only plain files of
 * exactly those names; a link or a folder standing at one is left.
 */
function removeBeside(snapshot) {
  const removed = []
  const dir = path.dirname(snapshot)
  const id = path.basename(snapshot).slice(0, -SNAPSHOT_SUFFIX.length)
  const beside = [responseFileFor(snapshot), listingFileFor(snapshot)]
  try {
    for (const name of fs.readdirSync(dir)) if (pictureName(id).test(name)) beside.push(path.join(dir, name))
  } catch {
    /* the folder is not there */
  }
  for (const file of beside) {
    let st = null
    try {
      st = fs.lstatSync(file)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    fs.rmSync(file, { force: true })
    removed.push(file)
  }
  return removed
}

/** The snapshot's text, when the file is one `prepare` wrote; the command ends otherwise. */
function preparedSnapshot(f, usage) {
  if (!f.snapshot) fail(usage, 2)
  if (!fs.existsSync(f.snapshot)) fail(`no snapshot at ${f.snapshot} — run prepare first`, 2)
  const text = readText(f.snapshot, "the snapshot")
  if (!isPreparedSnapshot(f.snapshot, text)) fail(`${f.snapshot} is not a snapshot written by prepare — run prepare first. Not uploading.`, 2)
  return text
}

function storedAnswer(file) {
  try {
    const answer = JSON.parse(fs.readFileSync(file, "utf8"))
    return answer !== null && typeof answer === "object" && !Array.isArray(answer) ? answer : null
  } catch {
    return null
  }
}

/**
 * Only a snapshot `prepare` wrote is uploaded: named `<session id>.rollout.jsonl`
 * and holding nothing that stays on this machine — taking the local-only parts
 * out of it again changes nothing. A rollout straight from Codex's own folder
 * fails both, so its instructions and account ids cannot leave through here.
 */
function isPreparedSnapshot(file, text) {
  const base = path.basename(file)
  return base.endsWith(SNAPSHOT_SUFFIX) && isThreadId(base.slice(0, -SNAPSHOT_SUFFIX.length)) && snapshotOf(text) === text
}

async function upload(f) {
  const ticket = f.ticket ?? process.env.EF_SHARE_UPLOAD_TICKET
  const usage = "usage: ef-share.mjs upload --snapshot <path> --url <uploadUrl> --ticket <ticket>"
  if (!f.url) fail(usage, 2)
  const text = preparedSnapshot(f, usage)
  let answer
  try {
    answer = await uploadSnapshot({ snapshotPath: f.snapshot, url: f.url, ticket })
  } catch (e) {
    fail(e.message)
  }
  const responseFile = responseFileFor(f.snapshot)
  try {
    fs.rmSync(responseFile, { force: true })
    fs.writeFileSync(responseFile, JSON.stringify(answer), { mode: 0o600, flag: "wx" })
  } catch (e) {
    fail(`uploaded, but cannot store the answer at ${responseFile}: ${e.message}`)
  }
  const { results_list, results, result_notes } = await listPages(f.snapshot, text, answer)
  print({
    response_file: responseFile,
    runtime: answer.runtime,
    suggestedTitle: answer.suggestedTitle ?? null,
    metadata: answer.metadata ?? null,
    redaction_groups: groupCandidates(answer.redactionCandidates).map(({ spans, ...g }) => g),
    chapterCandidates: answer.chapterCandidates ?? null,
    // pages the session wrote that could be published with it — only on the person's yes, with `send-results`
    results_list,
    results,
    result_notes,
  })
}

/** The list again — with the pages the person named in front. Sends nothing. */
async function results(f) {
  const usage = 'usage: ef-share.mjs results --snapshot <path> [--result "<page>"]…'
  const text = preparedSnapshot(f, usage)
  const answer = storedAnswer(responseFileFor(f.snapshot))
  if (!answer) fail(`no stored upload answer for ${f.snapshot} — run upload first`, 2)
  print(await listPages(f.snapshot, text, answer, f.result ?? []))
}

/**
 * The snapshot again, with the results the person chose — the one command
 * through which a result leaves this machine. Everything is checked and the
 * whole request is built before the ticket is used.
 */
async function sendResults(f) {
  const ticket = f.ticket ?? process.env.EF_SHARE_UPLOAD_TICKET
  const usage = "usage: ef-share.mjs send-results --snapshot <path> --url <uploadUrl> --ticket <ticket> --list <results_list> --results <ids, comma-separated> [--pictures none]"
  if (!f.url || !f.results || !f.list) fail(usage, 2)
  if (f.pictures !== undefined && f.pictures !== "none") fail(`--pictures takes "none" (publish the results without their preview pictures), got "${f.pictures}"`, 2)
  const text = preparedSnapshot(f, usage)
  const notSent = (errors) => fail(`nothing was sent — fix these first:\n- ${errors.join("\n- ")}`, 2)
  let ids
  try {
    ids = parseResultSelection(f.results)
  } catch (e) {
    notSent([e.message])
  }
  // The list this snapshot's `upload` (or `results`) wrote — not one left by an earlier publish, not one changed since.
  const list = readListing(listingFileFor(f.snapshot), sha256Hex(Buffer.from(text)))
  if (!list) notSent([`there is no list of results for ${f.snapshot} — run upload (or results) first: only a result that was listed is sent`])
  // A yes is a yes to one list: the numbers mean what they meant in the list the person answered, or nothing is sent.
  if (f.list !== list.results_list) {
    notSent([`--list ${f.list} is not the list of results as it stands now: the list has changed since the user answered — run results, show the new list and ask again`])
  }
  // Each chosen result is described afresh and must be what was listed (in a worker that is ended at its limit).
  let verified
  try {
    verified = await bounded("verifyChosen", { listing: list.results, ids, folders: sessionFolders(text) }, VERIFY_LIMIT_MS)
  } catch (e) {
    notSent([`the chosen results could not be checked: ${e.message}`])
  }
  if (verified.errors.length > 0) notSent(verified.errors)
  const listing = verified.results
  const taken = f.pictures === "none"
    ? { previews: new Map(), notes: [] }
    : await takeResultPreviews(listing, ids, (id) => pictureFileFor(f.snapshot, id))
  // Inside Codex's sandbox the browser that takes the picture does not start (measured on Codex 0.171, macOS,
  // CODEX_SANDBOX=seatbelt: no picture; the same capture outside it: a picture in 0.6 s). Sending now would use the
  // ticket on a result without the picture the person was told about — said here instead, while it is unused.
  const sandbox = process.env.CODEX_SANDBOX
  const browserFailed = taken.notes.filter((n) => /: the browser (?:did not produce a picture|could not be started)$/.test(n))
  if (sandbox && browserFailed.length > 0) {
    notSent([
      ...browserFailed,
      `this command ran inside Codex's sandbox (${sandbox}), where the browser that takes the picture cannot start: ` +
        "run it again outside the sandbox — that takes the user's approval for this one run — or add --pictures none to publish the result without a picture",
    ])
  }
  const plan = planResultsUploadFitting({ snapshot: Buffer.from(text), listing, ids, previews: taken.previews })
  if (plan.errors.length > 0) notSent(plan.errors)

  const responseFile = responseFileFor(f.snapshot)
  const before = storedAnswer(responseFile)
  let answer
  try {
    answer = await uploadSnapshot({ snapshotPath: f.snapshot, url: f.url, ticket, parts: plan.parts })
  } catch (e) {
    fail(e.message)
  }
  try {
    fs.rmSync(responseFile, { force: true })
    fs.writeFileSync(responseFile, JSON.stringify(answer), { mode: 0o600, flag: "wx" })
  } catch (e) {
    fail(`uploaded, but cannot store the answer at ${responseFile}: ${e.message}`)
  }

  const notes = [...taken.notes, ...plan.notes]
  let sent = plan.sent.results
  const accepted = answer.accepted !== null && typeof answer.accepted === "object" ? answer.accepted : null
  if (!accepted || typeof accepted.results !== "number" || accepted.results < sent.length) {
    notes.push(
      accepted && typeof accepted.results === "number"
        ? `the server took ${accepted.results} of the ${sent.length} results`
        : "this server kept only the session: the results were NOT taken",
    )
  }
  // A server that predates the pictures takes the upload and drops them without a word; one that knows them says how many it kept.
  const pictures = sent.filter((r) => r.preview).length
  if (accepted && pictures > 0 && (typeof accepted.previews !== "number" || accepted.previews < pictures)) {
    notes.push(
      typeof accepted.previews === "number"
        ? `the server kept ${accepted.previews} of the ${pictures} preview pictures`
        : "this server does not take preview pictures yet: the results are published without one",
    )
    if (typeof accepted.previews !== "number") sent = sent.map(({ preview_file, ...r }) => ({ ...r, preview: false }))
  }
  const groups = groupCandidates(answer.redactionCandidates)
  print({
    response_file: responseFile,
    runtime: answer.runtime,
    suggestedTitle: answer.suggestedTitle ?? null,
    metadata: answer.metadata ?? null,
    // what went with the snapshot: each result, its files, and the picture of its page on this machine
    sent,
    accepted: accepted ? { results: accepted.results ?? 0, previews: accepted.previews ?? 0 } : null,
    notes,
    // secrets found in a result's files: a result is published byte for byte and cannot be redacted
    resultWarnings: Array.isArray(answer.resultWarnings) ? answer.resultWarnings : [],
    redaction_groups: groups.map(({ spans, ...g }) => g),
    // true: the groups are the ones the first upload answered with — what the person chose still stands
    redaction_groups_unchanged: before ? JSON.stringify(groupCandidates(before.redactionCandidates)) === JSON.stringify(groups) : null,
    chapterCandidates: answer.chapterCandidates ?? null,
  })
}

function redactions(f) {
  if (!f.response || !f.select) {
    fail("usage: ef-share.mjs redactions --response <upload.json> --select <none | all | secrets | group numbers | kinds, comma-separated>", 2)
  }
  let answer
  try {
    answer = JSON.parse(readText(f.response, "the upload answer"))
  } catch (e) {
    fail(`${f.response} is not a stored upload answer: ${e.message}`, 2)
  }
  try {
    print({ redactions: selectRedactions(groupCandidates(answer?.redactionCandidates), f.select) })
  } catch (e) {
    fail(e.message, 2)
  }
}

function provenance(f) {
  if (!f.snapshot) fail("usage: ef-share.mjs provenance --snapshot <path>", 2)
  print(extractProvenance(readText(f.snapshot, "the snapshot")))
}

/**
 * Remove the snapshot and what was stored beside it — the upload answer, the
 * list of results, the preview pictures; the work folder too when it is one
 * this script made. Only a file `prepare` wrote is touched: named
 * `<session id>.rollout.jsonl` and beginning with that session's `session_meta`.
 */
function clean(f) {
  if (!f.snapshot) fail("usage: ef-share.mjs clean --snapshot <path>", 2)
  const snapshot = path.resolve(f.snapshot)
  const id = path.basename(snapshot).slice(0, -SNAPSHOT_SUFFIX.length)
  const notOurs = () => fail(`${f.snapshot} is not a snapshot written by prepare — nothing removed`, 2)
  if (!path.basename(snapshot).endsWith(SNAPSHOT_SUFFIX) || !isThreadId(id)) notOurs()
  const removed = []
  let stat = null
  try {
    stat = fs.lstatSync(snapshot)
  } catch {
    /* already gone: only its leftovers remain to remove */
  }
  if (stat) {
    // its first record names the session; a snapshot holds nothing prepare would have taken out
    const text = stat.isFile() ? readText(snapshot, "the snapshot") : ""
    if (!stat.isFile() || rolloutThreadId(text) !== id || !isPreparedSnapshot(snapshot, text)) notOurs()
    fs.rmSync(snapshot, { force: true })
    removed.push(snapshot)
  }
  const dir = path.dirname(snapshot)
  removed.push(...removeBeside(snapshot))
  let inTemp = false
  try {
    inTemp = fs.realpathSync(path.dirname(dir)) === fs.realpathSync(os.tmpdir())
  } catch {
    /* the folder is gone too */
  }
  if (path.basename(dir).startsWith(WORK_PREFIX) && inTemp) {
    try {
      fs.rmdirSync(dir) // only if empty
      removed.push(dir)
    } catch {
      /* something else is in it — leave it */
    }
  }
  print({ removed })
}

const [command, ...rest] = process.argv.slice(2)
if (!Object.hasOwn(COMMANDS, command ?? "")) {
  fail(`usage: ef-share.mjs <${Object.keys(COMMANDS).join("|")}> [options]`, 2)
}
const f = flags(command, rest)
switch (command) {
  case "prepare":
    prepare(f)
    break
  case "upload":
    await upload(f)
    break
  case "results":
    await results(f)
    break
  case "send-results":
    await sendResults(f)
    break
  case "redactions":
    redactions(f)
    break
  case "provenance":
    provenance(f)
    break
  case "clean":
    clean(f)
    break
}
