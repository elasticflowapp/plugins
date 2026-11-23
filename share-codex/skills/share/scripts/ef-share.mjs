#!/usr/bin/env node
// ef-share for Codex — the local half of publishing a Codex session to
// ElasticFlow Share. The `share` skill drives it:
//
//   prepare     find THIS session's rollout, write the snapshot of it that is uploaded
//   upload      send the snapshot with the single-use ticket from share_begin
//   redactions  turn the person's redaction choice into the share_publish array
//   provenance  where the session's skills and plugins come from (best effort)
//   clean       remove the snapshot and the stored upload answer
//
// No dependencies; needs Node 18+.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { codexHome, describeRollout, findRollout, isThreadId, publishMarker, rolloutThreadId, snapshotOf } from "./lib/rollout.mjs"
import { groupCandidates, selectRedactions, uploadSnapshot } from "./lib/upload.mjs"
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
  redactions: ["response", "select"],
  provenance: ["snapshot"],
  clean: ["snapshot"],
}

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
  if (!f.snapshot || !f.url) fail("usage: ef-share.mjs upload --snapshot <path> --url <uploadUrl> --ticket <ticket>", 2)
  if (!fs.existsSync(f.snapshot)) fail(`no snapshot at ${f.snapshot} — run prepare first`, 2)
  if (!isPreparedSnapshot(f.snapshot, readText(f.snapshot, "the snapshot"))) {
    fail(`${f.snapshot} is not a snapshot written by prepare — run prepare first. Not uploading.`, 2)
  }
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
  print({
    response_file: responseFile,
    runtime: answer.runtime,
    suggestedTitle: answer.suggestedTitle ?? null,
    metadata: answer.metadata ?? null,
    redaction_groups: groupCandidates(answer.redactionCandidates).map(({ spans, ...g }) => g),
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
 * Remove the snapshot and the stored answer; the work folder too when it is one
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
  const answer = responseFileFor(snapshot)
  if (fs.existsSync(answer) && fs.lstatSync(answer).isFile()) {
    fs.rmSync(answer, { force: true })
    removed.push(answer)
  }
  const dir = path.dirname(snapshot)
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
