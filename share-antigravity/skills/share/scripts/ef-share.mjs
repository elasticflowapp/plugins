#!/usr/bin/env node
// ef-share for Antigravity — the local half of publishing an Antigravity session
// to ElasticFlow Share. The `share` skill drives it:
//
//   prepare       find THIS conversation's transcript, write the snapshot that is uploaded
//   upload        send the snapshot with the single-use ticket from share_begin; list the
//                 pages the session wrote that could be published as results
//   results       list them again, with a page the person named
//   send-results  send the snapshot again, with the results the person chose
//   redactions    turn the person's redaction choice into the share_publish array
//   clean         remove the snapshot and what was stored beside it
//
// No dependencies; needs Node 18+.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  conversationOfPath, dataDirs, describeTranscript, findTranscript, isConversationId, publishMarker, sessionFolders, sessionHeader, snapshotConversationId, snapshotOf,
  surfaceOf,
} from "./lib/transcript.mjs"
import { groupCandidates, selectRedactions, uploadSnapshot } from "./lib/upload.mjs"
import {
  VERIFY_LIMIT_MS, bounded, listId, listResultsBounded, pagesFromAnswer, parseResultSelection, planResultsUploadFitting, readListing, resultsForDisplay, roomForResults,
  sha256Hex, takeResultPreviews, writeListing,
} from "./lib/results.mjs"

const WORK_PREFIX = "ef-share-antigravity-"
const SNAPSHOT_SUFFIX = ".transcript.jsonl"

/** The plugin's version, from its manifest three folders up; null for a skill copied out of the plugin. */
function clientVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL("../../../plugin.json", import.meta.url), "utf8"))
    return manifest.name === "ef-share" && typeof manifest.version === "string" ? manifest.version : null
  } catch {
    return null
  }
}

const COMMANDS = {
  prepare: ["conversation", "transcript", "out"],
  upload: ["snapshot", "url", "ticket"],
  results: ["snapshot", "result"],
  "send-results": ["snapshot", "url", "ticket", "results", "list", "pictures"],
  redactions: ["response", "select"],
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
  // set but empty is not "outside a session": something cleared it, and guessing which conversation is meant is not ours to do
  if (process.env.ANTIGRAVITY_CONVERSATION_ID === "") fail("ANTIGRAVITY_CONVERSATION_ID is set but empty. Not publishing.", 2)
  const current = process.env.ANTIGRAVITY_CONVERSATION_ID ?? null
  if (current && !isConversationId(current)) fail(`ANTIGRAVITY_CONVERSATION_ID "${current}" is not a conversation id. Not publishing.`, 2)
  // Inside a conversation the session is the one running — an option cannot name
  // another, by id or by path: the transcript holds no id of its own, so a path
  // would be believed. --conversation / --transcript exist for a person
  // publishing from a terminal.
  if (current && f.conversation && f.conversation !== current) {
    fail(`this is conversation ${current}; --conversation names ${f.conversation}. Not publishing another session from inside this one.`, 2)
  }
  if (current && f.transcript) {
    fail(`this is conversation ${current}: its transcript is found by that id, --transcript is for publishing from a terminal. Not publishing.`, 2)
  }
  const conversationId = current ?? f.conversation ?? null
  if (conversationId && !isConversationId(conversationId)) fail(`"${conversationId}" is not an Antigravity conversation id`, 2)

  let file = f.transcript ?? null
  let dataDir = null
  if (file) {
    const of = conversationOfPath(file)
    if (!of) fail(`${file} is not an Antigravity transcript (…/brain/<conversation id>/.system_generated/logs/transcript_full.jsonl). Not publishing.`, 2)
    if (conversationId && of !== conversationId) fail(`${file} belongs to conversation ${of}, not ${conversationId}. Not publishing.`, 2)
    dataDir = path.resolve(file, "..", "..", "..", "..", "..")
  } else {
    if (!conversationId) {
      fail("couldn't resolve the current Antigravity conversation: ANTIGRAVITY_CONVERSATION_ID is not set in this shell. Not publishing.", 2)
    }
    const found = findTranscript(conversationId)
    if (!found) fail(`no transcript for conversation ${conversationId} under ${dataDirs().map((d) => `${d}/brain`).join(", ")}. Not publishing.`, 2)
    file = found.file
    dataDir = found.dataDir
  }
  const recorded = conversationId ?? conversationOfPath(file)
  // The folder's name is the only thing that says whose transcript this is: a
  // link named after one conversation that leads to another's is not believed.
  let real = null
  try {
    real = fs.realpathSync(file)
  } catch (e) {
    fail(`cannot read the transcript ${file}: ${e.message}`, 2)
  }
  // where the links lead, only the conversation's own folder name is compared: a
  // `brain` kept on another disk under another name is still this conversation's
  if (conversationOfPath(real, { anyParent: true }) !== recorded) fail(`${file} leads to another conversation's transcript (${real}). Not publishing.`, 2)

  // The transcript as Antigravity wrote it: what of it is shown, and what is
  // never stored, is the server's to decide.
  const whole = snapshotOf(readText(file, "the transcript"))
  const info = describeTranscript(whole)
  if (info.userInputs === 0) fail("this conversation has no messages to publish yet", 2)
  // From inside the session, the publish starts where the snapshot ends; a
  // session published from a terminal later has no such point.
  const inSession = current !== null && recorded === current
  const header = sessionHeader({
    conversationId: recorded,
    surface: surfaceOf(dataDir),
    // where the publish was run from — the agent's shell stands in the conversation's folder
    cwd: inSession ? workingDirectory() : null,
    antigravityVersion: inSession ? process.env.ANTIGRAVITY_LS_VERSION || null : null,
    clientVersion: clientVersion(),
  })
  const body = header + "\n" + whole + (inSession ? publishMarker(clientVersion()) + "\n" : "")
  const snapshot = path.join(workDir(f), `${recorded}${SNAPSHOT_SUFFIX}`)
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
    conversation_id: recorded,
    surface: surfaceOf(dataDir),
    steps: info.steps,
    bytes: Buffer.byteLength(body),
  })
}

function workingDirectory() {
  try {
    return process.cwd()
  } catch {
    return null // the folder was removed under the shell
  }
}

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

/** The name of a preview picture `send-results` wrote for the snapshot `<id>.transcript.jsonl`. */
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

/**
 * The snapshot's text, when the file is one `prepare` wrote: named
 * `<conversation id>.transcript.jsonl` and beginning with that conversation's
 * session record. The command ends otherwise.
 */
function preparedSnapshot(f, usage) {
  if (!f.snapshot) fail(usage, 2)
  if (!f.snapshot.endsWith(SNAPSHOT_SUFFIX) || !fs.existsSync(f.snapshot)) fail(`no snapshot at ${f.snapshot} — run prepare first`, 2)
  const text = readText(f.snapshot, "the snapshot")
  const id = path.basename(f.snapshot).slice(0, -SNAPSHOT_SUFFIX.length)
  if (!isConversationId(id) || snapshotConversationId(text) !== id) fail(`${f.snapshot} is not a snapshot written by prepare — run prepare first. Not uploading.`, 2)
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

async function upload(f) {
  const ticket = f.ticket ?? process.env.EF_SHARE_UPLOAD_TICKET
  if (!f.snapshot || !f.url) fail("usage: ef-share.mjs upload --snapshot <path> --url <uploadUrl> --ticket <ticket>", 2)
  if (!f.snapshot.endsWith(SNAPSHOT_SUFFIX) || !fs.existsSync(f.snapshot)) fail(`no snapshot at ${f.snapshot} — run prepare first`, 2)
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
  const { results_list, results, result_notes } = await listPages(f.snapshot, readText(f.snapshot, "the snapshot"), answer)
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

/**
 * Remove the snapshot and what was stored beside it — the upload answer, the
 * list of results, the preview pictures; the work folder too when it is one
 * this script made. Only a file `prepare` wrote is touched: named
 * `<conversation id>.transcript.jsonl` and beginning with that conversation's
 * session record.
 */
function clean(f) {
  if (!f.snapshot) fail("usage: ef-share.mjs clean --snapshot <path>", 2)
  const snapshot = path.resolve(f.snapshot)
  const base = path.basename(snapshot)
  const notOurs = () => fail(`${f.snapshot} is not a snapshot written by prepare — nothing removed`, 2)
  if (!base.endsWith(SNAPSHOT_SUFFIX)) notOurs()
  const id = base.slice(0, -SNAPSHOT_SUFFIX.length)
  if (!isConversationId(id)) notOurs()
  const removed = []
  let stat = null
  try {
    stat = fs.lstatSync(snapshot)
  } catch {
    /* already gone: only its leftovers remain to remove */
  }
  if (stat) {
    if (!stat.isFile()) notOurs()
    // its first record names the conversation; only the head of the file is read
    let head = ""
    try {
      const fd = fs.openSync(snapshot, "r")
      const buf = Buffer.alloc(65536)
      head = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0))
      fs.closeSync(fd)
    } catch (e) {
      fail(`cannot read the snapshot ${f.snapshot}: ${e.message}`, 2)
    }
    if (snapshotConversationId(head) !== id) notOurs()
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
  case "clean":
    clean(f)
    break
}
