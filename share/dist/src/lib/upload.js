// packages/ef-share-plugin/src/lib/upload.ts
//
// `ef-share-session upload` — one ticketed multipart request carrying the
// prepared directory:
//
//   session.jsonl | session.jsonl.gz        the main transcript
//   subagent.<id>.jsonl.gz                  each sub-agent's transcript
//   subagent.<id>.meta.json                 its type / description / tool_use id
//   enrichment.<name>.json                  automations, chapters, hidden_records,
//                                           skills, plugins, workflows — staged
//                                           server-side, so share_publish carries
//                                           only what the person decided
//   results.json + result.<id>.<n>          ONLY the results the person chose
//   result.<id>.preview                     a picture of each chosen result's page,
//                                           taken on this machine (preview.ts)
//   client.json                             what prepared this upload
//
// The request is built completely, measured, and checked against the upload
// budget BEFORE a byte is sent: a body the endpoint would refuse is refused
// here, with the size and what to leave out.
//
// A server that predates this (it reads `session.jsonl` and ignores the rest)
// still gets a transcript it can publish; the response then has no `accepted`
// block and the caller is told the extra parts were not taken.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { mergeAuthoredAutomations, validateAuthoredChapters } from "./authored.js";
import { RESULT_LIMITS } from "./results.js";
import { mimeFor, unpublishableEntry, unpublishablePath } from "./result-types.js";
import { PLAIN_TRANSCRIPT_MAX, PART_OVERHEAD_BYTES, SERVER_LIMITS, uploadBudget, mb } from "./limits.js";
import { isAllowedUploadUrl } from "./upload-url.js";
import { UsageError } from "./cli-args.js";
import { lstatOrNull, notPreparedMessage, readPreparedJson, requirePreparedDir } from "./prepared-dir.js";
import { PREVIEW, captureResultPreview, pngSize, previewsOff } from "./preview.js";
export { PLAIN_TRANSCRIPT_MAX } from "./limits.js";
export { mimeFor } from "./result-types.js";
export { isAllowedUploadUrl } from "./upload-url.js";
/** Results one upload may carry (the server's limit: viewer/lib/uploads/staged-upload.ts UPLOAD_LIMITS.results). */
export const MAX_RESULTS_PER_UPLOAD = 12;
export function parseResultSelection(raw) {
    if (!raw || raw === "none")
        return [];
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n < 1))
        throw new Error(`--results takes "none" or a comma-separated list of result ids, got "${raw}"`);
    return [...new Set(ids)];
}
function jsonPart(value) {
    return new Blob([JSON.stringify(value)], { type: "application/json" });
}
/** The paths prepare writes, derived from the directory — never read back out of a file inside it. */
function layout(dir) {
    const ex = (name) => path.join(dir, "extract", `${name}.json`);
    return {
        manifest: path.join(dir, "manifest.json"),
        transcript: path.join(dir, "session.jsonl"),
        results: path.join(dir, "results.json"),
        authoredAutomations: path.join(dir, "authored", "automations.json"),
        authoredChapters: path.join(dir, "authored", "chapters.json"),
        ex,
    };
}
/**
 * A sub-agent id as prepare writes it: the `<id>` of the `agent-<id>.jsonl`
 * names Claude Code gives sub-agent transcripts — Workflow agents included —
 * which is all session-files.ts reads off disk.
 */
const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const readOwn = readPreparedJson;
/** The directory, its manifest and its sub-agent files, every one checked; the session's size against the server's limits. */
function checkPrepared(dirArg, limits) {
    const { dir, manifest: head } = requirePreparedDir(dirArg);
    const refuse = (reason) => { throw new UsageError(notPreparedMessage(dirArg, reason)); };
    const manifest = head;
    const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
    if (!isObject(manifest.transcript.stats) || !isObject(manifest.subagents) || !Array.isArray(manifest.subagents.items))
        refuse("its manifest.json is not one prepare wrote");
    /** `folder/name` as a plain file of its own; null when it is not there */
    const plainFile = (folder, name, shown) => {
        const file = path.join(folder, name);
        if (path.dirname(file) !== folder)
            refuse(`${shown} is not a file name prepare writes`);
        const st = lstatOrNull(file);
        if (!st)
            return null;
        if (!st.isFile())
            refuse(`${shown} is a symbolic link or not a regular file`);
        if (st.nlink > 1)
            refuse(`${shown} is a hard link to another file`);
        return { file, bytes: st.size };
    };
    const main = plainFile(dir, "session.jsonl", "session.jsonl");
    if (!main)
        refuse("it has no session.jsonl");
    const subDir = path.join(dir, "subagents");
    const subStat = lstatOrNull(subDir);
    if (subStat && (subStat.isSymbolicLink() || !subStat.isDirectory()))
        refuse("its subagents/ folder is a symbolic link or not a folder");
    const subagents = [];
    for (const item of manifest.subagents.items) {
        const id = isObject(item) ? item.agent_id : undefined;
        if (typeof id !== "string" || !AGENT_ID.test(id)) {
            refuse(`its manifest names a sub-agent ${typeof id === "string" ? JSON.stringify(id.slice(0, 100)) : "without a usable id"} that prepare would not write`);
        }
        if (!subStat)
            continue;
        const sid = id;
        const jsonl = plainFile(subDir, `agent-${sid}.jsonl`, `subagents/agent-${sid}.jsonl`);
        if (!jsonl)
            continue; // listed, and not on disk: nothing to send, as before
        const meta = plainFile(subDir, `agent-${sid}.meta.json`, `subagents/agent-${sid}.meta.json`);
        subagents.push({ id: sid, jsonl: jsonl.file, bytes: jsonl.bytes, meta: meta?.file ?? null });
    }
    // The server measures the transcripts DECOMPRESSED (limits.ts SERVER_LIMITS); prepare warned, upload refuses.
    const over = [];
    if (main.bytes > limits.transcriptBytes) {
        over.push(`the main transcript is ${mb(main.bytes)}; the server takes at most ${mb(limits.transcriptBytes)} of it unpacked — this session is too large to publish in one upload`);
    }
    const tooBig = subagents.filter((s) => s.bytes > limits.subagentBytes);
    for (const s of tooBig.slice(0, 5))
        over.push(`the transcript of sub-agent ${s.id} is ${mb(s.bytes)}; the server takes at most ${mb(limits.subagentBytes)} of one unpacked`);
    if (tooBig.length > 5)
        over.push(`${tooBig.length - 5} more sub-agent transcripts are over ${mb(limits.subagentBytes)}`);
    const subTotal = subagents.reduce((sum, s) => sum + s.bytes, 0);
    if (subTotal > limits.subagentTotalBytes)
        over.push(`the sub-agent transcripts are ${mb(subTotal)} together; the server takes at most ${mb(limits.subagentTotalBytes)} of them unpacked`);
    if (over.length > 0)
        throw new UsageError(nothingUploaded(over));
    return { dir, manifest, transcript: main.file, subagents };
}
function nothingUploaded(errors) {
    return `nothing was uploaded — fix these first:\n- ${errors.join("\n- ")}`;
}
/** results.json as prepare wrote it: a list. */
function readResults(file) {
    const list = readOwn(file);
    if (list === null && !fs.existsSync(file))
        return [];
    return Array.isArray(list) ? list : null;
}
const RESULTS_NOT_LIST = `results.json is not the list prepare wrote — run prepare again`;
/**
 * A result file as it is about to be read: still where prepare found it, still
 * inside the entry page's folder, still a file the server takes. The list in
 * results.json was written minutes ago and is only a list.
 */
function checkedResultFile(root, rel, abs) {
    let real;
    try {
        real = fs.realpathSync(abs);
    }
    catch {
        return { problem: `${rel} is no longer on disk` };
    }
    const back = path.relative(root, real).split(path.sep).join("/");
    if (back !== rel)
        return { problem: `${rel} is not where it was when the results were listed` };
    const unpublishable = unpublishablePath(rel);
    return unpublishable ? { problem: `${rel}: ${unpublishable}` } : { real };
}
/** A sha256 as prepare records it. */
const DIGEST = /^[0-9a-f]{64}$/;
const noDigest = (rel) => `the list of results records no digest of ${rel} (it was made by an older ef-share)`;
/**
 * The files of one listed result, each checked again by the rules prepare
 * listed it by (results.ts describeResult): the page is the file the list
 * names; every other file is inside the page's folder, not hidden, of a type
 * the server takes; each one is a regular file, the size it was when listed,
 * within the limits of one result. The paths returned are the real ones that
 * were checked — what is read, and what a preview picture is taken of.
 *
 * Each comes with the digest prepare recorded. The size says only that a file
 * is as long as it was; whoever reads the file — the upload, the local server
 * the picture is taken from — compares what it read with the digest, and a file
 * that holds something else is not sent or served (release review 2026-11-20,
 * note 9).
 */
function resultFiles(r) {
    const L = RESULT_LIMITS;
    const MB = 1048576;
    const fail = (problem) => ({ files: [], problem });
    if (!r || typeof r.path !== "string" || !path.isAbsolute(r.path) || typeof r.bytes !== "number" || !Array.isArray(r.assets))
        return fail("the list of results is not prepare's");
    if (path.basename(r.path) !== r.entry)
        return fail(`the path the list gives for ${r.entry} is another file (${path.basename(r.path)})`);
    let real;
    let st;
    try {
        real = fs.realpathSync(r.path);
        st = fs.statSync(real);
    }
    catch {
        return fail(`${r.entry} is no longer on disk`);
    }
    if (!st.isFile())
        return fail(`${r.entry} is not a regular file`);
    if (st.size !== r.bytes)
        return fail(`${r.entry} changed since the results were listed`);
    if (st.size > L.maxEntryBytes)
        return fail(`${r.entry} is larger than ${Math.round(L.maxEntryBytes / MB)} MB`);
    if (r.assets.length > L.maxAssets)
        return fail(`it lists more than ${L.maxAssets} files — one result carries at most ${L.maxAssets}`);
    const root = path.dirname(real);
    // the digests are read off the list as they stand and judged once every file has been looked at (below)
    const files = [{ rel: r.entry, abs: real, bytes: st.size, sha256: r.sha256 }];
    let total = st.size;
    for (const a of r.assets) {
        if (!a || typeof a.rel !== "string" || typeof a.abs !== "string" || typeof a.bytes !== "number")
            return fail("the list of results is not prepare's");
        const at = checkedResultFile(root, a.rel, a.abs);
        if ("problem" in at)
            return fail(at.problem);
        let ast;
        try {
            ast = fs.statSync(at.real);
        }
        catch {
            return fail(`${a.rel} is no longer on disk`);
        }
        if (!ast.isFile())
            return fail(`${a.rel} is not a regular file`);
        if (ast.size !== a.bytes)
            return fail(`${a.rel} changed since the results were listed`);
        if (ast.size > L.maxAssetBytes)
            return fail(`${a.rel} is larger than ${Math.round(L.maxAssetBytes / MB)} MB`);
        total += ast.size;
        if (total > L.maxTotalBytes)
            return fail(`the result is larger than ${Math.round(L.maxTotalBytes / MB)} MB`);
        files.push({ rel: a.rel, abs: at.real, bytes: ast.size, sha256: a.sha256 });
    }
    // asked last: every refusal above says more about what is wrong with a file than that its digest is missing
    for (const f of files)
        if (typeof f.sha256 !== "string" || !DIGEST.test(f.sha256))
            return fail(noDigest(f.rel));
    return { files, problem: null };
}
export function buildUploadPlan(dir, resultIds, opts = {}) {
    const errors = [];
    const notes = [];
    const at = layout(dir);
    // refused here, before anything in the directory is read for the request or written (final/)
    const checked = checkPrepared(dir, opts.serverLimits ?? SERVER_LIMITS);
    const manifest = checked.manifest;
    const budget = opts.budgetBytes ?? uploadBudget();
    const parts = [];
    const add = (name, blob, filename) => parts.push({ name, blob, filename });
    // ── sub-agents ──
    let subagents = 0;
    for (const s of checked.subagents) {
        add(`subagent.${s.id}.jsonl.gz`, new Blob([gzipSync(fs.readFileSync(s.jsonl))], { type: "application/gzip" }), `agent-${s.id}.jsonl.gz`);
        if (s.meta)
            add(`subagent.${s.id}.meta.json`, new Blob([fs.readFileSync(s.meta)], { type: "application/json" }), `agent-${s.id}.meta.json`);
        subagents++;
    }
    // ── staged enrichment ──
    // Each payload is also written to <dir>/final/ exactly as sent: a server that
    // predates staging needs them back as share_publish arguments (share.md step 9).
    const finalDir = path.join(dir, "final");
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.mkdirSync(finalDir, { recursive: true, mode: 0o700 });
    const enrichment = [];
    const stage = (name, value) => {
        add(`enrichment.${name}.json`, jsonPart(value), `${name}.json`);
        fs.writeFileSync(path.join(finalDir, `${name}.json`), JSON.stringify(value), { mode: 0o600 });
        enrichment.push(name);
    };
    const candidates = readOwn(at.ex("automations"));
    if (candidates && candidates.kinds.length > 0) {
        const exists = fs.existsSync(at.authoredAutomations);
        const authored = exists ? readOwn(at.authoredAutomations) : undefined;
        if (exists && authored === null)
            errors.push(`${at.authoredAutomations} is not valid JSON`);
        const merged = mergeAuthoredAutomations(candidates, authored ?? undefined);
        errors.push(...merged.errors);
        stage("automations", merged.value);
    }
    const turns = readOwn(at.ex("chapters"));
    if (turns && fs.existsSync(at.authoredChapters)) {
        const authored = readOwn(at.authoredChapters);
        if (authored === null)
            errors.push(`${at.authoredChapters} is not valid JSON`);
        else {
            const checked = validateAuthoredChapters(turns, authored);
            errors.push(...checked.errors);
            if (checked.value)
                stage("chapters", checked.value);
        }
    }
    const hidden = readOwn(at.ex("hidden_records"));
    if (hidden)
        stage("hidden_records", hidden.hidden_records);
    const skills = readOwn(at.ex("skills"));
    if (skills && Array.isArray(skills.skills) && skills.skills.length > 0)
        stage("skills", skills);
    const plugins = readOwn(at.ex("plugins"));
    if (plugins && Array.isArray(plugins.plugins) && plugins.plugins.length > 0)
        stage("plugins", plugins);
    const workflows = readOwn(at.ex("workflows"));
    if (workflows && Array.isArray(workflows.runs) && workflows.runs.length > 0)
        stage("workflows", workflows);
    // ── results: only what was chosen ──
    const sentResults = [];
    if (resultIds.length > MAX_RESULTS_PER_UPLOAD) {
        // The list can hold more candidates than one publish takes (a page the person
        // named is listed on top of the twelve most recent). Said here, before the
        // body is sent, instead of by a 413 after it.
        errors.push(`--results: ${resultIds.length} results chosen — one publish takes at most ${MAX_RESULTS_PER_UPLOAD}`);
    }
    else if (resultIds.length > 0) {
        const all = readResults(at.results);
        if (all === null)
            errors.push(`--results: ${RESULTS_NOT_LIST}`);
        const out = [];
        for (const id of all === null ? [] : resultIds) {
            const r = all.find((c) => c && typeof c === "object" && c.id === id);
            if (!r) {
                errors.push(`--results: there is no result ${id} (see results in the prepare output)`);
                continue;
            }
            if (r.blocked) {
                errors.push(`--results: result ${id} (${r.entry}) cannot be published: ${r.blocked}`);
                continue;
            }
            const entryProblem = typeof r.entry === "string" ? unpublishableEntry(r.entry) : "the list of results is not prepare's";
            if (entryProblem) {
                errors.push(`--results: result ${id} (${r.entry}) cannot be published: ${entryProblem}`);
                continue;
            }
            const files = [];
            const staged = [];
            let bytes = 0;
            const listed = resultFiles(r);
            let problem = listed.problem;
            for (const f of listed.files) {
                let buf;
                try {
                    buf = fs.readFileSync(f.abs);
                }
                catch (e) {
                    problem = `${f.rel} could not be read: ${e.message}`;
                    break;
                }
                // the bytes that are sent are the bytes that were listed: the same length is not the same file
                const digest = crypto.createHash("sha256").update(buf).digest("hex");
                if (buf.length !== f.bytes || digest !== f.sha256) {
                    problem = `${f.rel} changed since the results were listed`;
                    break;
                }
                const part = `result.${id}.${files.length}`;
                staged.push({ part, blob: new Blob([buf], { type: mimeFor(f.rel) }), filename: path.basename(f.rel) });
                files.push({ part, rel: f.rel, bytes: buf.length, sha256: digest });
                bytes += buf.length;
            }
            if (problem) {
                errors.push(`--results: result ${id} (${r.entry}) cannot be published: ${problem} — run prepare again`);
                continue;
            }
            for (const s of staged)
                add(s.part, s.blob, s.filename);
            // the picture of the page, when one was taken: its own part, never one of the result's files
            let preview;
            const taken = opts.previews?.get(id);
            if (taken) {
                let png;
                try {
                    png = fs.readFileSync(taken.file);
                }
                catch {
                    png = null;
                }
                // the numbers sent describe the bytes sent: read from the file, not carried over from the capture
                const size = png ? pngSize(png) : null;
                if (png && size) {
                    const part = `result.${id}.preview`;
                    add(part, new Blob([png], { type: "image/png" }), `preview-${id}.png`);
                    preview = { part, bytes: png.length, sha256: crypto.createHash("sha256").update(png).digest("hex"), width: size.width, height: size.height };
                }
                else {
                    notes.push(`no preview picture for result ${id} (${r.entry}): the picture that was taken could not be read back`);
                }
            }
            out.push({ id, entry: r.entry, files, remote_hosts: r.remote_hosts, ...(preview ? { preview } : {}) });
            sentResults.push({ id, entry: r.entry, files: files.length, bytes, preview: !!preview, ...(preview && taken ? { preview_file: taken.file } : {}) });
        }
        if (out.length > 0)
            add("results.json", jsonPart({ result_contract_version: "1.0.0", results: out }), "results.json");
    }
    add("client.json", jsonPart({
        client: "ef-share-plugin",
        prepare_version: manifest.prepare_version,
        claude_code_versions: manifest.transcript.claude_code_versions,
        entrypoints: manifest.transcript.entrypoints,
        transcript: { records: manifest.transcript.stats.records_kept, left_on_client_by_kind: manifest.transcript.stats.dropped_by_kind },
        subagents: { count: manifest.subagents.count, not_included: manifest.subagents.not_included, tool_results_trimmed_to: manifest.subagents.tool_results_trimmed_to },
    }), "client.json");
    // ── main transcript, sized against what is left of the budget ──
    // Plain while it fits (every server version reads it); compressed when prepare
    // found it had to be, when it is over the plain limit, or when plain would not fit.
    const others = parts.reduce((sum, p) => sum + p.blob.size + PART_OVERHEAD_BYTES, 0);
    const main = fs.readFileSync(checked.transcript);
    const compress = manifest.upload_compress_transcript === true ||
        main.length > PLAIN_TRANSCRIPT_MAX ||
        others + main.length + PART_OVERHEAD_BYTES > budget;
    const mainPart = compress
        ? { name: "session.jsonl.gz", blob: new Blob([gzipSync(main)], { type: "application/gzip" }), filename: "session.jsonl.gz" }
        : { name: "session.jsonl", blob: new Blob([main], { type: "application/jsonl" }), filename: "session.jsonl" };
    const body = others + mainPart.blob.size + PART_OVERHEAD_BYTES;
    if (body > budget) {
        const resultBytes = sentResults.reduce((sum, r) => sum + r.bytes, 0);
        errors.push(`the upload would be ${mb(body)}, over the ${mb(budget)} the endpoint takes` +
            (resultBytes > 0
                ? ` — the chosen results are ${mb(resultBytes)} of it: publish fewer or smaller results`
                : ` — this session is too large to publish in one upload (set EF_SHARE_UPLOAD_BUDGET_BYTES only if your endpoint is known to take more)`));
    }
    const form = new FormData();
    for (const p of [mainPart, ...parts])
        form.append(p.name, p.blob, p.filename);
    return {
        form,
        errors,
        notes,
        sent: {
            transcript_bytes: main.length,
            transcript_compressed: compress,
            subagents,
            enrichment,
            results: sentResults,
            body_bytes: body,
            budget_bytes: budget,
        },
    };
}
/**
 * Take the preview picture of each chosen result (preview.ts). A result that
 * cannot be published is skipped here — buildUploadPlan names why; a picture
 * that could not be taken is a note, never an error: the result is published
 * without one.
 */
export async function takeResultPreviews(dir, resultIds, capture = captureResultPreview, opts = {}) {
    const previews = new Map();
    const notes = [];
    if (resultIds.length === 0 || resultIds.length > MAX_RESULTS_PER_UPLOAD)
        return { previews, notes };
    const all = readResults(layout(dir).results) ?? [];
    // A picture is taken only of a result that will be published, and only of the files checked for it:
    // the picture is uploaded, so a page that loads a file the result may not carry is not photographed.
    const wanted = resultIds
        .map((id) => all.find((c) => c && typeof c === "object" && c.id === id))
        .filter((r) => !!r && !r.blocked && typeof r.entry === "string" && !unpublishableEntry(r.entry))
        .map((r) => ({ r, listed: resultFiles(r) }))
        .filter((w) => w.listed.problem === null);
    if (wanted.length === 0)
        return { previews, notes };
    // only the built-in capture reads the environment: a capture handed in by the caller is the caller's choice
    if (capture === captureResultPreview && previewsOff()) {
        notes.push("no preview pictures were taken: they are turned off (EF_SHARE_PREVIEW=off)");
        return { previews, notes };
    }
    // One clock for all the pictures: the upload ticket is short-lived, and the pictures are
    // taken before the request is sent (review 2026-11-16, C-3: twelve slow pages outlived it).
    const now = opts.now ?? Date.now;
    const total = opts.totalMs ?? PREVIEW.totalMs;
    const started = now();
    for (const { r, listed } of wanted) {
        const left = total - (now() - started);
        if (left < 1000) {
            notes.push(`no preview picture for result ${r.id} (${r.entry}): the ${Math.round(total / 1000)} s allowed for the pictures of one upload ran out`);
            continue;
        }
        let outcome;
        try {
            outcome = await capture({
                entry: r.entry,
                // with each file's digest: the local server hands the browser the listed bytes or nothing
                files: listed.files.map((f) => ({ rel: f.rel, abs: f.abs, sha256: f.sha256 })),
                remoteHosts: r.remote_hosts,
                outFile: path.join(dir, "previews", `${r.id}.png`),
                timeoutMs: Math.min(PREVIEW.timeoutMs, left),
            });
        }
        catch (e) {
            outcome = { ok: false, reason: e.message };
        }
        if (outcome.ok)
            previews.set(r.id, { file: outcome.file, width: outcome.width, height: outcome.height });
        else
            notes.push(`no preview picture for result ${r.id} (${r.entry}): ${outcome.reason}`);
    }
    return { previews, notes };
}
export async function uploadPrepared(opts) {
    if (!isAllowedUploadUrl(opts.url))
        throw new UsageError(`refusing to upload to ${opts.url}: not an ElasticFlow Share endpoint`);
    // the directory, its manifest, its sub-agent files and the session's size: before a picture is taken or a byte read for the request
    checkPrepared(opts.dir, opts.serverLimits ?? SERVER_LIMITS);
    const taken = opts.capturePreview === null
        ? { previews: new Map(), notes: [] }
        : await takeResultPreviews(opts.dir, opts.resultIds, opts.capturePreview);
    let plan = buildUploadPlan(opts.dir, opts.resultIds, { budgetBytes: opts.budgetBytes, previews: taken.previews, serverLimits: opts.serverLimits });
    // A picture is a nicety: when it is what pushes the request over the limit, send without it.
    if (plan.errors.some((e) => e.startsWith("the upload would be")) && taken.previews.size > 0) {
        const without = buildUploadPlan(opts.dir, opts.resultIds, { budgetBytes: opts.budgetBytes, serverLimits: opts.serverLimits });
        if (!without.errors.some((e) => e.startsWith("the upload would be"))) {
            const ids = plan.sent.results.filter((r) => r.preview).map((r) => r.id);
            plan = without;
            taken.notes.push(`the preview pictures of result${ids.length === 1 ? "" : "s"} ${ids.join(", ")} were left out: with them the upload would be over the size the endpoint takes`);
        }
    }
    if (plan.errors.length > 0)
        throw new UsageError(nothingUploaded(plan.errors));
    const doFetch = opts.fetchImpl ?? fetch;
    // Never follow a redirect: a 307/308 would send the body and the ticket again, to wherever it
    // points (review 2026-11-20, A-6). The answer is taken as it comes, and a redirect is a failed request.
    const res = await doFetch(opts.url, { method: "POST", headers: { "X-Upload-Ticket": opts.ticket }, body: plan.form, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(res.status) || res.type === "opaqueredirect") {
        try {
            await res.body?.cancel();
        }
        catch { /* nothing to read */ }
        const to = res.headers.get("location");
        throw new Error(`the upload was not completed: ${opts.url} answered ${res.status}, a redirect to ${to ? to.slice(0, 300) : "an address it did not give"} — ef-share does not follow redirects, so nothing was sent there`);
    }
    const text = await res.text();
    let response = text;
    try {
        response = JSON.parse(text);
    }
    catch { /* a proxy's html error page stays text */ }
    const accepted = response && typeof response === "object" ? response["accepted"] : undefined;
    const staged = !!accepted && typeof accepted === "object";
    const notes = [...taken.notes, ...plan.notes];
    let sent = plan.sent;
    // A server that predates the pictures takes the upload and drops them without a word
    // (review 2026-11-16, C-8). One that knows them says how many it kept.
    const picturesSent = plan.sent.results.filter((r) => r.preview).length;
    if (res.ok && staged && picturesSent > 0) {
        const kept = accepted["previews"];
        if (typeof kept !== "number" || kept < picturesSent) {
            notes.push(typeof kept === "number"
                ? `the server kept ${kept} of the ${picturesSent} preview pictures`
                : "this server does not take preview pictures yet: the results are published without one");
            if (typeof kept !== "number")
                sent = { ...sent, results: sent.results.map((r) => ({ id: r.id, entry: r.entry, files: r.files, bytes: r.bytes, preview: false })) };
        }
    }
    if (res.ok && !staged) {
        notes.push("this server kept only the main transcript: sub-agents, results and staged enrichment were NOT taken. " +
            "Pass automations / chapters / hidden_records / skills / plugins to share_publish as arguments instead.");
    }
    if (res.status === 413) {
        // 413 has three causes; the server's JSON names two of them, a proxy's page none
        const code = response && typeof response === "object" ? String(response["error"] ?? "") : "";
        if (code === "too_many_results")
            notes.push("the server takes fewer results in one publish than were chosen — choose fewer");
        else if (code === "too_many_subagents")
            notes.push("the session has more sub-agent transcripts than the server takes in one publish");
        // `too_large` from the server is about ONE part after decompression (a transcript, a
        // sub-agent's, a result file) and says which; only a proxy's bare 413 is about the body
        else if (code === "too_large")
            notes.push(`the server refused a part as too large: ${String(response["message"] ?? "no detail given").slice(0, 300)}`);
        else
            notes.push(`the endpoint refused ${mb(plan.sent.body_bytes)} as too large (413) — it takes less than this tool assumes; set EF_SHARE_UPLOAD_BUDGET_BYTES to its limit and run prepare again`);
    }
    if (res.status === 401)
        notes.push("the ticket was rejected (expired or already used) — call share_begin again and re-run upload");
    return { ok: res.ok, status: res.status, response, sent, staged, notes };
}
