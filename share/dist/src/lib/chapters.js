// packages/ef-share-plugin/src/lib/chapters.ts
//
// Deterministic candidate extractor for chapter authoring (ADR-0010).
// Lists the session's human user-turn starts with REAL record uuids so the
// author-chapters skill can group them into chapters without inventing
// anchors. The server independently validates every start_record_ref against
// the raw transcript and re-derives all objective facts (viewer/lib/chapters).
import { records, userText, NON_HUMAN_ORIGINS, INTERRUPT_MARKER } from "./transcript.js";
import { extractHiddenRecords } from "./hidden-records.js";
const MAX_CANDIDATES = 500;
const PREVIEW_CHARS = 120;
/**
 * The uuid of every record inside a publishing span (the `/share` command, its
 * steps, the replies to its questions — see hidden-records.ts). The server hides
 * those records and numbers the session's turns without them, so a chapter
 * anchored on one cannot be placed; the server then drops EVERY authored chapter
 * for a generated one and says nothing. Such a turn is therefore never a
 * candidate, and the authored-file check refuses a chapter that starts on one.
 */
function publishingRecordUuids(jsonl) {
    const spans = extractHiddenRecords(jsonl).hidden_records;
    const inside = new Set();
    if (spans.length === 0)
        return inside;
    const endOf = new Map(spans.map((s) => [s.start_record_ref, s.end_record_ref]));
    let end = null;
    for (const r of records(jsonl)) {
        const uuid = r["uuid"] ? String(r["uuid"]) : null;
        if (!uuid)
            continue;
        if (end === null && endOf.has(uuid))
            end = endOf.get(uuid);
        if (end === null)
            continue;
        inside.add(uuid);
        if (uuid === end)
            end = null;
    }
    return inside;
}
/** Records the server makes no event of — the only ones that may stand between a command and its expansion. */
function isSilentRecord(r) {
    const t = r["type"];
    return t === "custom-title" || t === "ai-title" || (t === "system" && r["subtype"] === "local_command");
}
/** The CLI's own banners around a command it ran itself — never a turn, never a command's expansion. */
const isCommandPlumbing = (t) => t.startsWith("<local-command-");
export function extractChapterCandidates(jsonl) {
    const turns = [];
    const publishing = publishingRecordUuids(jsonl);
    let prevTs = null;
    const offer = (c) => {
        const tsMs = c.ts ? Date.parse(c.ts) : NaN;
        const gap = prevTs != null && Number.isFinite(tsMs) ? Math.max(0, Math.round((tsMs - prevTs) / 60_000)) : 0;
        if (Number.isFinite(tsMs))
            prevTs = tsMs;
        turns.push({ ...c, gap_minutes_before: gap });
    };
    // A typed command waits here for the record that follows it. The server gives a
    // command a turn of its own only when its expansion comes next — the runtime's copy
    // of what the model received, an isMeta user record (a skill or plugin command). A
    // command the CLI ran itself (/model, /effort, /autocompact: its output or the
    // person's next prompt follows) or one the model simply answered (/goal) has no
    // turn there; anchored on it, a chapter lands on a neighbour's turn and the server
    // drops every authored chapter (review round 2, B2-1; 42 typed commands measured).
    let command = null;
    for (const r of records(jsonl)) {
        // Sub-agent (Task) turns are inlined with isSidechain; the server's
        // uuid→turn map covers the MAIN track only, so a sidechain anchor would
        // invalidate the whole chapter set (silent fallback). Exclude them.
        if (r["isSidechain"] === true)
            continue;
        if (r["type"] !== "user") {
            // The expansion must be the very next thing the server makes an event of. An
            // assistant reply, a hook's context, a change of mode in between leaves the
            // command without a turn (review round 3, R3-4); only what the server makes no
            // event of may stand there.
            if (command && !isSilentRecord(r))
                command = null;
            continue;
        }
        const msg = (r["message"] ?? {});
        const raw = userText(msg["content"]);
        const t = raw == null ? "" : raw.trim();
        if (command) {
            const expansion = r["isMeta"] === true && t !== "" && !isCommandPlumbing(t);
            if (expansion && turns.length < MAX_CANDIDATES)
                offer(command);
            command = null;
        }
        if (turns.length >= MAX_CANDIDATES)
            break;
        if (r["isMeta"] === true || r["isCompactSummary"] === true)
            continue;
        const uuid = r["uuid"] ? String(r["uuid"]) : null;
        if (!uuid)
            continue;
        if (publishing.has(uuid))
            continue;
        if (!t)
            continue;
        // Runtime plumbing that sometimes arrives without isMeta — never a turn start.
        if (isCommandPlumbing(t))
            continue;
        // A chapter starts where the PERSON started something. Records the runtime
        // wrote on its own — a background agent reporting back, another agent's
        // message, a schedule firing — are not candidates.
        const origin = r["turnOrigin"];
        if (typeof origin === "string" && NON_HUMAN_ORIGINS.has(origin))
            continue;
        if (t.startsWith("<task-notification>"))
            continue;
        // "[Request interrupted by user…]" is written by the runtime when the person
        // presses Esc — a turn in the file, not something they typed.
        if (INTERRUPT_MARKER.test(t))
            continue;
        const ts = r["timestamp"] ? String(r["timestamp"]) : null;
        const cmd = /<command-name>([^<]+)<\/command-name>/.exec(t);
        if (cmd) {
            const slash = cmd[1].trim();
            const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
            const preview = ((args?.[1] ?? "").trim() || slash).replace(/\s+/g, " ").slice(0, PREVIEW_CHARS);
            command = { start_record_ref: uuid, ts, slash, preview };
            continue;
        }
        offer({ start_record_ref: uuid, ts, slash: null, preview: t.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS) });
    }
    return { chapter_contract_version: "1.0.0", runtime: "claude-code", total_candidates: turns.length, turns };
}
