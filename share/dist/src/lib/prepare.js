// packages/ef-share-plugin/src/lib/prepare.ts
//
// `ef-share-session prepare` — everything deterministic about a publish, in one
// step and from ONE reading of the transcript.
//
// The live transcript keeps growing while /share runs, and the server rejects
// any chapter / automation / hidden-record ref that is not in the uploaded
// file. So the transcript is read once, minimised (sanitize.ts), written to a
// prepared directory, and every extractor runs on that same prepared text.
//
//   <dir>/session.jsonl                 the main transcript, as it will be uploaded
//   <dir>/subagents/agent-<id>.jsonl    each sub-agent's transcript (+ .meta.json)
//   <dir>/extract/*.json                automation + chapter candidates, hidden
//                                       records, skill / plugin provenance, workflows
//   <dir>/results.json                  result candidates (nothing is copied yet)
//   <dir>/authored/                     where the publishing agent writes titles
//   <dir>/manifest.json                 this run, in full
//
// The directory holds a copy of the session, so it is private to the user
// (0700, files 0600) and is the tool's own: prepare writes only into a new
// directory, an empty one, or one an earlier prepare made.
//
// The account's identifiers (organisation and account ids, the e-mail) are
// collected from the main transcript AND every sub-agent transcript before
// anything is written, and replaced in every published record and in every JSON
// part written beside them (sanitize.ts: minimiseTranscript, finishTranscript).
// Two readers see the text before that replacement, because they look for files
// on disk and upload none of the paths they read: skill provenance (it walks up
// from the session's working directories) and result discovery (it uploads a
// page's name and the names of its files relative to the page's folder). Every
// extract that IS uploaded — chapters, automations, hidden records, plugins,
// workflows — and every size is computed from the replaced text.
//
// Nothing here talks to the network.
import fs from "node:fs";
import path from "node:path";
import { minimiseTranscript, finishTranscript, collectAccountIdentifiers, replaceAccountIdentifiers, takeAccountFields, collectIdentifiersFromPaths, emptyAccountIdentifiers, zeroAccountCounts, ACCOUNT_IDENTIFIER_KINDS, } from "./sanitize.js";
import { listSubagentFiles, listWorkflowRuns } from "./session-files.js";
import { extractAutomationCandidates } from "./automations.js";
import { extractChapterCandidates } from "./chapters.js";
import { extractHiddenRecords } from "./hidden-records.js";
import { collectSkillProvenance, collectSessionPluginProvenance } from "./provenance.js";
import { findResultCandidates } from "./results.js";
import { records, readJson } from "./transcript.js";
import { PLAIN_TRANSCRIPT_MAX, PART_OVERHEAD_BYTES, SERVER_LIMITS, uploadBudget, mb } from "./limits.js";
import { UsageError } from "./cli-args.js";
export const PREPARE_VERSION = 2;
/** Sub-agent tool output is trimmed, in steps, only when the upload would not fit. */
export const TRIM_STEPS = [0, 16000, 4000, 1000];
export { DEFAULT_UPLOAD_BUDGET } from "./limits.js";
export const MAX_SUBAGENTS = 300;
function envelopeFacts(jsonl) {
    let sessionId = null;
    const versions = new Set();
    const entrypoints = new Set();
    for (const r of records(jsonl)) {
        if (sessionId === null && typeof r["sessionId"] === "string")
            sessionId = r["sessionId"];
        if (typeof r["version"] === "string")
            versions.add(r["version"]);
        if (typeof r["entrypoint"] === "string")
            entrypoints.add(r["entrypoint"]);
    }
    return { sessionId, versions: [...versions].sort(), entrypoints: [...entrypoints].sort() };
}
const TRIM_MARK = (more) => `\n… [${more.toLocaleString("en-US")} more characters not published — trimmed by ef-share to fit the upload]`;
function trimString(s, limit) {
    return s.length <= limit ? s : s.slice(0, limit) + TRIM_MARK(s.length - limit);
}
/** Cut every tool_result body of a transcript to `limit` characters. 0 = leave as is. */
export function trimToolResults(jsonl, limit) {
    if (limit <= 0)
        return jsonl;
    const out = [];
    for (const line of jsonl.split("\n")) {
        if (!line)
            continue;
        let r;
        try {
            r = JSON.parse(line);
        }
        catch {
            continue;
        }
        const content = (r["message"] ?? {})["content"];
        let changed = false;
        if (r["type"] === "user" && Array.isArray(content)) {
            for (const part of content) {
                if (!part || typeof part !== "object" || part["type"] !== "tool_result")
                    continue;
                const body = part["content"];
                if (typeof body === "string") {
                    if (body.length > limit) {
                        part["content"] = trimString(body, limit);
                        changed = true;
                    }
                }
                else if (Array.isArray(body)) {
                    for (const sub of body) {
                        if (sub && typeof sub === "object" && sub["type"] === "text" && typeof sub["text"] === "string") {
                            const t = sub["text"];
                            if (t.length > limit) {
                                sub["text"] = trimString(t, limit);
                                changed = true;
                            }
                        }
                    }
                }
            }
        }
        out.push(changed ? JSON.stringify(r) : line);
    }
    return out.length > 0 ? out.join("\n") + "\n" : "";
}
/** The fields of a sub-agent's meta file the server stores (viewer/lib/uploads/staged-upload.ts). Nothing else is sent. */
const META_STRINGS = { agentType: 120, description: 500, toolUseId: 120, workflowRunId: 80, requestShape: 40, model: 120, pickedEffortModel: 120, parentAgentId: 80 };
const META_BOOLEANS = ["finished", "stoppedByUser"];
export function slimSubagentMeta(meta) {
    const out = {};
    for (const [k, max] of Object.entries(META_STRINGS))
        if (typeof meta[k] === "string" && meta[k])
            out[k] = meta[k].slice(0, max);
    for (const k of META_BOOLEANS)
        if (typeof meta[k] === "boolean")
            out[k] = meta[k];
    if (typeof meta["spawnDepth"] === "number" && Number.isInteger(meta["spawnDepth"]))
        out["spawnDepth"] = meta["spawnDepth"];
    return out;
}
// ─── the prepared directory ──────────────────────────────────────────────────
/** True iff `dir` holds the manifest of an earlier `prepare` run. */
export function isPreparedDir(dir) {
    const m = readJson(path.join(dir, "manifest.json"));
    return !!m && typeof m.prepare_version === "number";
}
function mkdirPrivate(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(dir, 0o700);
    }
    catch { /* a file system without modes */ }
}
function writePrivate(file, data) {
    mkdirPrivate(path.dirname(file));
    fs.writeFileSync(file, data, { mode: 0o600 });
    try {
        fs.chmodSync(file, 0o600);
    }
    catch { /* a file system without modes */ }
}
/**
 * Take `dir` as this run's output directory. Prepare writes manifest.json,
 * session.jsonl and results.json at its top level, so it only ever does that in
 * a directory that is new, empty, or its own — never among someone else's files
 * (review 2026-11-16, P-12: `--out <a project folder>` replaced that project's
 * manifest.json).
 */
function claimOutDir(dir) {
    let st = null;
    try {
        st = fs.lstatSync(dir);
    }
    catch {
        st = null;
    }
    if (st) {
        if (!st.isDirectory())
            throw new UsageError(`--out ${dir} is not a directory`);
        if (fs.readdirSync(dir).length > 0) {
            if (!isPreparedDir(dir))
                throw new UsageError(`${dir} is not empty and was not made by "ef-share-session prepare" — not writing into it`);
            // an earlier run's derived files; `authored/` is the publishing agent's and stays
            for (const stale of ["subagents", "extract", "final"])
                fs.rmSync(path.join(dir, stale), { recursive: true, force: true });
        }
    }
    mkdirPrivate(dir);
}
function writeJson(file, value) {
    const text = JSON.stringify(value);
    writePrivate(file, text);
    return Buffer.byteLength(text);
}
function mergeCounts(into, from) {
    for (const [k, v] of Object.entries(from))
        into[k] = (into[k] ?? 0) + v;
}
function readOrNull(file) {
    try {
        return fs.readFileSync(file, "utf-8");
    }
    catch {
        return null;
    }
}
export async function prepareSession(opts) {
    const { gzipSync } = await import("node:zlib");
    const gzipSize = opts.gzipSize ?? ((text) => gzipSync(Buffer.from(text)).length);
    const budget = opts.uploadBudgetBytes ?? uploadBudget();
    const warnings = [];
    const source = path.resolve(opts.transcriptPath);
    const raw = fs.readFileSync(source, "utf-8");
    const facts = envelopeFacts(raw);
    // First pass over every transcript of the session — the main one and each
    // sub-agent's — before a byte of any of them is written: it minimises them and
    // collects the account's identifiers from all of them, since a sub-agent
    // repeats ids only the main transcript's dropped records name, and the other
    // way round. The second pass (finishTranscript) replaces them.
    const accountIds = emptyAccountIdentifiers();
    // The account this machine is signed in to, from Claude Code's own record of it — the
    // one source that does not depend on what the session wrote down. Read for three
    // values only; a file that is missing or is not what is expected names nothing.
    if (opts.accountFile) {
        const config = readJson(opts.accountFile);
        if (config && typeof config === "object")
            takeAccountFields(config["oauthAccount"], accountIds);
    }
    const mainMin = minimiseTranscript(raw, accountIds);
    if (mainMin.stats.records_kept === 0)
        throw new UsageError(`no publishable records in ${source} — this is not a session transcript, or the session has not started yet`);
    const subDropped = {};
    const subFields = {};
    let subInjections = 0;
    const minimised = [];
    let notIncluded = 0;
    for (const f of listSubagentFiles(source)) {
        const text = readOrNull(f.jsonlPath);
        if (text === null) {
            notIncluded++;
            continue;
        }
        // not prepared, but its ids may be repeated in one that is
        if (minimised.length >= MAX_SUBAGENTS) {
            collectAccountIdentifiers(text, accountIds);
            notIncluded++;
            continue;
        }
        const m = minimiseTranscript(text, accountIds);
        mergeCounts(subDropped, m.stats.dropped_by_kind);
        mergeCounts(subFields, m.stats.fields_dropped);
        subInjections += m.stats.hook_injections;
        if (m.stats.records_kept === 0) {
            notIncluded++;
            continue;
        }
        minimised.push({ file: f, m });
    }
    if (notIncluded > 0)
        warnings.push(`${notIncluded} sub-agent transcript(s) on disk were not prepared (empty, unreadable, or beyond ${MAX_SUBAGENTS})`);
    // Two readers keep the identifiers, because they look for files on disk by
    // the paths the session used and upload none of those paths: result discovery
    // (it uploads names relative to a page's folder) and skill provenance (it walks
    // up from the session's working directories). They read the first pass's text.
    const toolCalls = (m) => m.lines.filter((l) => l.includes('"tool_use"')).join("\n");
    const resultSources = [{ jsonl: toolCalls(mainMin), subagent: false }, ...minimised.map(({ m }) => ({ jsonl: toolCalls(m), subagent: true }))];
    const replacedElsewhere = zeroAccountCounts();
    let skills = null;
    try {
        skills = replaceAccountIdentifiers(collectSkillProvenance(mainMin.lines.join("\n"), opts.home), accountIds, replacedElsewhere);
    }
    catch (e) {
        warnings.push(`skill provenance skipped: ${e.message}`);
    }
    const main = finishTranscript(mainMin, accountIds);
    mainMin.lines = []; // the published text is all that is needed from here on
    const dir = path.resolve(opts.outDir);
    claimOutDir(dir);
    mkdirPrivate(path.join(dir, "authored"));
    const mainFile = path.join(dir, "session.jsonl");
    writePrivate(mainFile, main.jsonl);
    // ── sub-agents ──────────────────────────────────────────────────────────
    let subWithheld = 0;
    const subReplaced = zeroAccountCounts();
    const prepared = [];
    for (const { file: f, m } of minimised) {
        const s = finishTranscript(m, accountIds);
        m.lines = [];
        subWithheld += s.stats.instruction_blocks_withheld;
        mergeCounts(subReplaced, s.stats.account_identifiers_replaced);
        let meta = f.metaPath ? readJson(f.metaPath) : null;
        if (meta && (typeof meta !== "object" || Array.isArray(meta)))
            meta = null;
        if (f.workflowRunId)
            meta = { ...(meta ?? {}), workflowRunId: f.workflowRunId };
        // the meta's description is written by the model, like the transcript it describes;
        // a path in it can be the only place that names an id (review round 3, R3-5)
        if (meta)
            collectIdentifiersFromPaths(JSON.stringify(meta), accountIds);
        const slim = meta ? replaceAccountIdentifiers(slimSubagentMeta(meta), accountIds, subReplaced) : null;
        prepared.push({
            jsonl: s.jsonl,
            meta: slim && Object.keys(slim).length > 0 ? JSON.stringify(slim) : null,
            item: {
                agent_id: f.agentId,
                agent_type: typeof slim?.["agentType"] === "string" ? slim["agentType"] : null,
                description: typeof slim?.["description"] === "string" ? slim["description"].slice(0, 200) : null,
                workflow_run_id: f.workflowRunId,
                records: s.stats.records_kept,
                bytes: s.stats.bytes_out,
            },
        });
    }
    // ── deterministic extracts, all from the prepared main transcript ───────
    const automations = extractAutomationCandidates(main.jsonl);
    const chapters = extractChapterCandidates(main.jsonl);
    const hidden = extractHiddenRecords(main.jsonl);
    let plugins = null;
    try {
        // only the plugins the published transcripts refer to
        plugins = collectSessionPluginProvenance([main.jsonl, ...prepared.map((p) => p.jsonl)], opts.pluginsRoot);
        plugins.payload = replaceAccountIdentifiers(plugins.payload, accountIds, replacedElsewhere);
    }
    catch (e) {
        warnings.push(`plugin provenance skipped: ${e.message}`);
    }
    const workflowRuns = listWorkflowRuns(source);
    collectIdentifiersFromPaths(JSON.stringify(workflowRuns), accountIds);
    const workflows = replaceAccountIdentifiers(workflowRuns, accountIds, replacedElsewhere);
    const ex = (name) => path.join(dir, "extract", `${name}.json`);
    const part = (bytes) => bytes + PART_OVERHEAD_BYTES;
    // Everything the upload sends besides the transcripts, at the size it is sent.
    // The authored titles do not exist yet: each automation kind may gain a title
    // and a reason (≤600 characters), and a chapter list is at most a few KB.
    writeJson(ex("chapters"), chapters); // candidates for the author; what is uploaded is the authored list
    const fixed = part(writeJson(ex("automations"), automations) + automations.kinds.length * 700) +
        part(16 * 1024) + // chapters, once authored
        part(writeJson(ex("hidden_records"), hidden)) +
        part(writeJson(ex("skills"), skills ?? { skills: [] })) +
        part(writeJson(ex("plugins"), plugins?.payload ?? { plugins: [] })) +
        part(writeJson(ex("workflows"), { workflow_contract_version: "1.0.0", runtime: "claude-code", runs: workflows })) +
        part(4 * 1024); // client.json
    // ── fit the upload ──────────────────────────────────────────────────────
    // The estimate is the request as upload.ts builds it, part by part. The main
    // transcript is never altered: it goes plain while that fits (every server
    // version reads it), compressed when it does not; only then is sub-agent tool
    // output cut, in steps, and the manifest says so.
    const mainRaw = Buffer.byteLength(main.jsonl);
    const mainGz = gzipSize(main.jsonl);
    const subsAt = (step) => prepared.reduce((sum, p) => sum + part(gzipSize(trimToolResults(p.jsonl, step))) + (p.meta ? part(Buffer.byteLength(p.meta)) : 0), 0);
    let compress = mainRaw > PLAIN_TRANSCRIPT_MAX;
    let trimmedTo = 0;
    let subs = subsAt(0);
    const total = () => part(compress ? mainGz : mainRaw) + fixed + subs;
    if (total() > budget)
        compress = true;
    if (total() > budget) {
        for (const step of TRIM_STEPS.slice(1)) {
            trimmedTo = step;
            subs = subsAt(step);
            if (total() <= budget)
                break;
        }
    }
    const estimate = total();
    const floor = part(mainGz) + fixed + subs;
    if (estimate > budget) {
        warnings.push(`the prepared upload is ${mb(estimate)}, over the ${mb(budget)} the endpoint takes, even with sub-agent output cut — ` +
            `"upload" will refuse to send it`);
    }
    if (trimmedTo > 0) {
        warnings.push(`sub-agent tool output was cut to ${trimmedTo.toLocaleString("en-US")} characters per result to fit the upload; the main transcript is complete`);
    }
    const subDir = path.join(dir, "subagents");
    let subBytes = 0;
    for (const p of prepared) {
        const text = trimToolResults(p.jsonl, trimmedTo);
        p.item.bytes = Buffer.byteLength(text);
        subBytes += p.item.bytes;
        writePrivate(path.join(subDir, `agent-${p.item.agent_id}.jsonl`), text);
        if (p.meta)
            writePrivate(path.join(subDir, `agent-${p.item.agent_id}.meta.json`), p.meta);
    }
    // The server measures the transcripts DECOMPRESSED; the request budget above is
    // about the compressed body. Say so here rather than let a 413 say it later.
    if (mainRaw > SERVER_LIMITS.transcriptBytes)
        warnings.push(`the main transcript is ${mb(mainRaw)}; the server takes at most ${mb(SERVER_LIMITS.transcriptBytes)} — the upload will be refused`);
    const tooBig = prepared.filter((p) => p.item.bytes > SERVER_LIMITS.subagentBytes);
    if (tooBig.length > 0)
        warnings.push(`${tooBig.length} sub-agent transcript(s) are over the ${mb(SERVER_LIMITS.subagentBytes)} the server takes for one (${tooBig.slice(0, 3).map((p) => `${p.item.agent_id}: ${mb(p.item.bytes)}`).join(", ")}) — the upload will be refused`);
    if (subBytes > SERVER_LIMITS.subagentTotalBytes)
        warnings.push(`the sub-agent transcripts are ${mb(subBytes)} together; the server takes at most ${mb(SERVER_LIMITS.subagentTotalBytes)} — the upload will be refused`);
    // ── result candidates: found and described, never copied here ───────────
    // From the first pass's tool calls (resultSources, above): the pages are looked
    // up on disk by the paths the session wrote them to — a desktop-app path holds
    // the account's ids.
    const resultNotes = [];
    const results = findResultCandidates(resultSources, opts.extraResults ?? [], resultNotes);
    warnings.push(...resultNotes);
    writeJson(path.join(dir, "results.json"), results);
    const manifest = {
        prepare_version: PREPARE_VERSION,
        dir,
        transcript: {
            source,
            session_id: facts.sessionId,
            claude_code_versions: facts.versions,
            entrypoints: facts.entrypoints,
            file: mainFile,
            stats: main.stats,
        },
        subagents: {
            count: prepared.length,
            not_included: notIncluded,
            bytes: subBytes,
            dropped_by_kind: subDropped,
            fields_dropped: subFields,
            hook_injections: subInjections,
            instruction_blocks_withheld: subWithheld,
            account_identifiers_replaced: subReplaced,
            tool_results_trimmed_to: trimmedTo,
            items: prepared.map((p) => p.item),
        },
        account_identifiers: {
            found: Object.fromEntries(ACCOUNT_IDENTIFIER_KINDS.map((k) => [k, accountIds[k].length])),
            replaced_elsewhere: replacedElsewhere,
        },
        workflows,
        extract: {
            automations: { file: ex("automations"), kinds: automations.kinds.length, occurrences: automations.occurrences.length },
            chapters: { file: ex("chapters"), turns: chapters.turns.length },
            hidden_records: { file: ex("hidden_records"), spans: hidden.hidden_records.length },
            skills: { file: ex("skills"), count: skills?.skills.length ?? 0 },
            plugins: { file: ex("plugins"), count: plugins?.payload.plugins.length ?? 0, installed: plugins?.installed ?? 0, sent: plugins?.sent ?? [], not_sent: plugins?.not_sent ?? [] },
            workflows: { file: ex("workflows"), count: workflows.length },
        },
        authored: {
            automations: path.join(dir, "authored", "automations.json"),
            chapters: path.join(dir, "authored", "chapters.json"),
        },
        results,
        upload_estimate_bytes: estimate,
        upload_budget_bytes: budget,
        upload_compress_transcript: compress,
        upload_floor_bytes: floor,
        warnings,
    };
    writeJson(path.join(dir, "manifest.json"), manifest);
    return manifest;
}
/** What the publishing agent reads: enough to act on, small enough to keep in context. */
export function summarizeManifest(m) {
    // EVERY kind that stays behind, not the most frequent few: the person is told
    // what does not leave, and "the system prompt" is one record among thousands.
    const counted = (d) => Object.entries(d).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([kind, n]) => `${kind} ×${n}`);
    // upload compresses the main transcript when that is what makes the chosen results fit
    const room = Math.max(0, m.upload_budget_bytes - m.upload_floor_bytes);
    return {
        dir: m.dir,
        session_id: m.transcript.session_id,
        claude_code: { versions: m.transcript.claude_code_versions, entrypoints: m.transcript.entrypoints },
        transcript: {
            records_published: m.transcript.stats.records_kept,
            records_left_on_this_machine: m.transcript.stats.records_dropped,
            left_on_this_machine_by_kind: counted(m.transcript.stats.dropped_by_kind),
            record_fields_left_on_this_machine: Object.keys(m.transcript.stats.fields_dropped).sort(),
            // context your own hooks put into the session is part of what is published
            hook_injections_published: m.transcript.stats.hook_injections + m.subagents.hook_injections,
            // instruction files (CLAUDE.md, memory) Claude Code copied into a message of its own: cut, one marker line each
            instruction_blocks_withheld: m.transcript.stats.instruction_blocks_withheld,
            // occurrences of the account's ids and e-mail in published records, replaced by [organisation-id] / [account-id] / [account-email]
            account_identifiers_replaced: m.transcript.stats.account_identifiers_replaced,
            bytes: m.transcript.stats.bytes_out,
        },
        subagents: {
            count: m.subagents.count,
            not_included: m.subagents.not_included,
            bytes: m.subagents.bytes,
            tool_results_trimmed_to: m.subagents.tool_results_trimmed_to,
            // the same account for the sub-agent transcripts as for the main one
            left_on_this_machine_by_kind: counted(m.subagents.dropped_by_kind),
            record_fields_left_on_this_machine: Object.keys(m.subagents.fields_dropped).sort(),
            instruction_blocks_withheld: m.subagents.instruction_blocks_withheld,
            account_identifiers_replaced: m.subagents.account_identifiers_replaced,
            by_type: Object.entries(m.subagents.items.reduce((acc, s) => {
                const k = s.agent_type ?? "(unknown)";
                acc[k] = (acc[k] ?? 0) + 1;
                return acc;
            }, {})).map(([type, n]) => `${type} ×${n}`),
        },
        // how many distinct ids of the account were found (never the values), and what was replaced outside the transcripts
        account_identifiers: m.account_identifiers,
        // the plugins whose provenance is uploaded: only those the session refers to
        plugins: { sent: m.extract.plugins.count, sent_names: m.extract.plugins.sent, installed_not_sent: m.extract.plugins.not_sent.length },
        workflows: m.workflows.map((w) => ({ name: w.name, status: w.status, agents: w.agent_count })),
        automations: { candidates: m.extract.automations.file, kinds: m.extract.automations.kinds, occurrences: m.extract.automations.occurrences, write_titles_to: m.authored.automations },
        chapters: { candidates: m.extract.chapters.file, turns: m.extract.chapters.turns, write_chapters_to: m.authored.chapters },
        hidden_publishing_spans: m.extract.hidden_records.spans,
        // A result is published byte for byte and cannot be redacted, so the question
        // "share this result?" is asked over the FILES, not over a count of them.
        results: m.results.map((r) => ({
            id: r.id,
            entry: r.entry,
            path: r.path,
            named_by_you: r.named,
            files: [r.entry, ...r.assets.map((a) => a.rel)],
            total_bytes: r.total_bytes,
            fits_this_upload: r.blocked === null && r.total_bytes <= room,
            last_touched_at: r.last_touched_at,
            not_published: r.skipped,
            loads_from_network: r.remote_hosts,
            blocked: r.blocked,
        })),
        upload_estimate_bytes: m.upload_estimate_bytes,
        upload_budget_bytes: m.upload_budget_bytes,
        room_for_results_bytes: room,
        warnings: m.warnings,
        manifest: path.join(m.dir, "manifest.json"),
    };
}
