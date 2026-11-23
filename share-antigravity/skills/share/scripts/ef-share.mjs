#!/usr/bin/env node
// ef-share for Antigravity — the local half of publishing an Antigravity session
// to ElasticFlow Share. The `share` skill drives it:
//
//   prepare     find THIS conversation's transcript, write the snapshot that is uploaded
//   upload      send the snapshot with the single-use ticket from share_begin
//   redactions  turn the person's redaction choice into the share_publish array
//   clean       remove the snapshot and the stored upload answer
//
// No dependencies; needs Node 18+.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  conversationOfPath, dataDirs, describeTranscript, findTranscript, isConversationId, publishMarker, sessionHeader, snapshotConversationId, snapshotOf, surfaceOf,
} from "./lib/transcript.mjs"
import { groupCandidates, selectRedactions, uploadSnapshot } from "./lib/upload.mjs"

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
  redactions: ["response", "select"],
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

/**
 * Remove the snapshot and the stored answer; the work folder too when it is one
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
  case "clean":
    clean(f)
    break
}
