// packages/ef-share-plugin/src/lib/hidden-records.ts
//
// Deterministic "Publishing record" detector for the ElasticFlow Share publish
// contract (the `hidden_records` Enrichment field — see ADR-0018 and
// docs/superpowers/specs/2026-06-17-share-publishing-record-hiding-design.md).
//
// The ef-share plugin (Claude Code runtime) knows its own publishing signature
// authoritatively, so it marks the transcript records that belong to the act of
// publishing — the `/share` command, the share MCP calls, the upload curl, the
// chapter/automation authoring skills, and any embedded publish Q&A reply — as
// uuid-anchored spans. The server validates the marks against the raw transcript
// (anti-fabrication), keeps the full transcript, and excludes the marked records
// from every reader-facing surface. Genuine work is never hidden — including work
// done *after* a publish in the same session.
//
// Shares record iteration, the person-vs-runtime rules and the interrupt marker
// with chapters.ts (the chapter candidate extractor) through ./transcript.ts.
import { records, userText as textOf, NON_HUMAN_ORIGINS, INTERRUPT_MARKER } from "./transcript.js";
/** A share-command user turn opens a publishing span. */
const SHARE_COMMAND = /^\s*\/?(?:ef-share:)?share\s*$/;
/** Share MCP tool names (current `mcp__plugin_ef-share_share__*` + the bare `mcp__share__*`). */
const SHARE_MCP_TOOL = /^mcp__(?:plugin_ef-share_share|share)__/;
/** Authoring skills invoked during publishing. */
const PUBLISH_SKILL = /author-chapters|classify-automations/;
/** Hosts the transcript upload curl targets. */
const SHARE_HOST = /elasticflow(?:app)?\.app|elasticflow\.dev|\bshare\b.*upload|upload.*\bshare\b/i;
/** The plugin's own prepare/upload tool (0.12+), run through Bash. */
const SHARE_TOOL = /\bef-share-session\b/;
/** The share command started by the model through the Skill tool instead of a typed `/share`. */
const SHARE_SKILL = /^(?:ef-share:)?share$/;
/** A published session URL: …/share/<id>. */
const SHARE_URL = /https?:\/\/\S*\/share\/[A-Za-z0-9]/;
/** Assistant narration that the publish completed. */
const PUBLISHED_DONE = /"?share_status"?\s*[:=]?\s*"?done"?|\bPublished:\s|\bshare_status\b.*\bdone\b/i;
/** A short embedded user reply answering a publish question (visibility / redactions). */
const PUBLISH_REPLY = /\b(public|private|unlisted|visibility|redact|redaction|no redactions|none|don'?t redact|all good|looks good|go ahead|publish it|yes)\b/i;
const PUBLISH_REPLY_MAX_CHARS = 200;
const MAX_SPANS = 64;
/** Concatenated text of an assistant record's text blocks (for narration / completion matching). */
function assistantText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const b of content) {
        if (b && typeof b === "object" && b["type"] === "text") {
            const t = b["text"];
            if (typeof t === "string")
                parts.push(t);
        }
    }
    return parts.join("\n");
}
/** tool_use blocks of an assistant record. */
function toolUses(content) {
    if (!Array.isArray(content))
        return [];
    return content.filter((b) => !!b && typeof b === "object" && b["type"] === "tool_use");
}
/** The `<command-name>` of a user record's text, or null. */
function commandName(text) {
    const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text);
    return cmd ? cmd[1].trim() : null;
}
/** Bash tool_use input typically carries the shell line under `command`. */
function bashCommand(tu) {
    const input = (tu["input"] ?? {});
    const cmd = input["command"];
    return typeof cmd === "string" ? cmd : "";
}
/**
 * Classify each MAIN-TRACK record into the role it plays for span detection.
 * Sidechain/meta/compact records are skipped (the server's uuid→turn map is
 * main-track only — mirrors chapters.ts).
 */
function classify(jsonl) {
    const items = [];
    for (const r of records(jsonl)) {
        if (r["isCompactSummary"] === true || r["isSidechain"] === true)
            continue;
        const uuid = r["uuid"] ? String(r["uuid"]) : null;
        if (!uuid)
            continue;
        const type = r["type"];
        const msg = (r["message"] ?? {});
        const content = msg["content"];
        // isMeta records are runtime plumbing — with one exception. A plugin command that
        // the runtime expands as a skill (the desktop app, or the model starting /share
        // through the Skill tool) leaves an isMeta record naming the command; that record
        // opens the publishing span exactly like a typed `/share`.
        if (r["isMeta"] === true) {
            const metaCmd = type === "user" ? commandName(textOf(content) ?? "") : null;
            if (metaCmd != null && SHARE_COMMAND.test(metaCmd))
                items.push({ uuid, kind: "share_command", completes: false });
            continue;
        }
        if (type === "assistant") {
            const tus = toolUses(content);
            const names = tus.map((t) => String(t["name"] ?? ""));
            const isShareMcp = names.some((n) => SHARE_MCP_TOOL.test(n));
            const isPublishSkill = names.some((n) => /Skill|Task/i.test(n)) &&
                tus.some((t) => PUBLISH_SKILL.test(JSON.stringify(t["input"] ?? "")));
            const isUploadCurl = tus.some((t) => {
                if (String(t["name"] ?? "") !== "Bash")
                    return false;
                const c = bashCommand(t);
                return (/\bcurl\b/.test(c) && SHARE_HOST.test(c)) || SHARE_TOOL.test(c);
            });
            // The model starting the share command itself (no typed `/share`) opens the span.
            const startsShare = tus.some((t) => String(t["name"] ?? "") === "Skill" && SHARE_SKILL.test(String((t["input"] ?? {})["skill"] ?? "").trim()));
            const text = assistantText(content);
            // Completion is ONLY a genuine publish-completed signal (share_status done /
            // "Published:" / a share URL) — a share-MCP tool_use is inside-span machinery,
            // not a terminator (begin/status calls precede the actual publish).
            const completes = PUBLISHED_DONE.test(text) || SHARE_URL.test(text);
            const isPublishMachinery = isShareMcp || isPublishSkill || isUploadCurl;
            // Assistant narration about publishing only counts as machinery while a
            // span is already open (handled at walk time); on its own an assistant
            // text record is a candidate "narration" signal.
            const narratesPublish = /\b(publish|share|redact|chapter|automation|upload)\b/i.test(text);
            items.push({
                uuid,
                kind: startsShare ? "share_command" : isPublishMachinery ? "publish_machinery" : (narratesPublish ? "publish_machinery" : "skip"),
                completes,
            });
            continue;
        }
        if (type !== "user") {
            items.push({ uuid, kind: "skip", completes: false });
            continue;
        }
        const raw = textOf(content);
        if (raw == null) {
            // tool_result-only / image-only user record — machinery filler inside a span.
            items.push({ uuid, kind: "skip", completes: false });
            continue;
        }
        const t = raw.trim();
        if (!t) {
            items.push({ uuid, kind: "skip", completes: false });
            continue;
        }
        // Runtime plumbing that sometimes arrives without isMeta — never a turn start.
        // Interrupt markers ([Request interrupted by user …]) are tool-use plumbing INSIDE
        // a flow, not a genuine human turn (BUG-2026-06-18-01).
        if (t.startsWith("<local-command-stdout>") || t.startsWith("<local-command-caveat>") || INTERRUPT_MARKER.test(t)) {
            items.push({ uuid, kind: "skip", completes: false });
            continue;
        }
        // A user record the runtime wrote on its own (a background agent reporting back,
        // a peer's message, a schedule firing) is not the person resuming work: it must
        // not end an open publishing span.
        const origin = r["turnOrigin"];
        if ((typeof origin === "string" && NON_HUMAN_ORIGINS.has(origin)) || t.startsWith("<task-notification>")) {
            items.push({ uuid, kind: "skip", completes: false });
            continue;
        }
        const cmd = commandName(t);
        if (cmd != null) {
            if (SHARE_COMMAND.test(cmd)) {
                items.push({ uuid, kind: "share_command", completes: false });
                continue;
            }
            // A different slash command is a genuine human turn.
            items.push({ uuid, kind: "human_turn", completes: false });
            continue;
        }
        // Plain typed text. Short Q&A-style replies are publish replies (only counted
        // inside an open span at walk time); anything else is a genuine human turn.
        const compact = t.replace(/\s+/g, " ");
        const isReply = compact.length <= PUBLISH_REPLY_MAX_CHARS && PUBLISH_REPLY.test(compact);
        items.push({ uuid, kind: isReply ? "publish_reply" : "human_turn", completes: false });
    }
    return items;
}
/**
 * Detect publishing spans.
 *
 * A span STARTS at a share-command user turn and extends through the contiguous
 * publishing flow, ENDING at the FIRST of:
 *   - the publish-completion record (assistant `share_status: done` / "Published:" /
 *     a share URL) — INCLUSIVE; a share-MCP tool_use is inside-span machinery, NOT a
 *     terminator (the walk only ends on completion text/URL); or
 *   - the record just before the next genuine non-publishing human turn; or
 *   - EOF.
 * No "Published:" is required, so a failed/aborted publish is covered identically.
 */
export function extractHiddenRecords(jsonl) {
    const items = classify(jsonl);
    const spans = [];
    let i = 0;
    while (i < items.length) {
        if (items[i].kind !== "share_command") {
            i++;
            continue;
        }
        const startUuid = items[i].uuid;
        let endUuid = startUuid; // single-record span by default (the trailing current publish)
        let j = i + 1;
        for (; j < items.length; j++) {
            const it = items[j];
            if (it.kind === "human_turn")
                break; // genuine work resumes → span ended before it
            // publish_machinery / publish_reply / skip all belong inside the span.
            endUuid = it.uuid;
            if (it.completes) {
                j++;
                break;
            } // completion record is the inclusive terminator
        }
        spans.push({ start_record_ref: startUuid, end_record_ref: endUuid, reason: "publishing", source_ref: "ef-share" });
        if (spans.length >= MAX_SPANS)
            break;
        i = j;
    }
    return { hidden_records: spans };
}
