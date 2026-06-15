// packages/ef-share-plugin/src/lib/chapters.ts
//
// Deterministic candidate extractor for chapter authoring (ADR-0010).
// Lists the session's human user-turn starts with REAL record uuids so the
// author-chapters skill can group them into chapters without inventing
// anchors. The server independently validates every start_record_ref against
// the raw transcript and re-derives all objective facts (viewer/lib/chapters).
const MAX_CANDIDATES = 500;
const PREVIEW_CHARS = 120;
function* records(jsonl) {
    for (const line of jsonl.split("\n")) {
        const s = line.trim();
        if (!s)
            continue;
        try {
            yield JSON.parse(s);
        }
        catch { /* skip */ }
    }
}
/** The user-visible text of a user record, or null when there is none
 *  (tool_result-only messages, image-only messages, malformed content). */
function textOf(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        for (const b of content) {
            if (b && typeof b === "object" && b["type"] === "text") {
                const t = b["text"];
                if (typeof t === "string")
                    return t;
            }
        }
    }
    return null;
}
export function extractChapterCandidates(jsonl) {
    const turns = [];
    let prevTs = null;
    for (const r of records(jsonl)) {
        if (r["type"] !== "user")
            continue;
        if (r["isMeta"] === true || r["isCompactSummary"] === true)
            continue;
        // Sub-agent (Task) turns are inlined with isSidechain; the server's
        // uuid→turn map covers the MAIN track only, so a sidechain anchor would
        // invalidate the whole chapter set (silent fallback). Exclude them.
        if (r["isSidechain"] === true)
            continue;
        const uuid = r["uuid"] ? String(r["uuid"]) : null;
        if (!uuid)
            continue;
        const msg = (r["message"] ?? {});
        const raw = textOf(msg["content"]);
        if (raw == null)
            continue;
        const t = raw.trim();
        if (!t)
            continue;
        // Runtime plumbing that sometimes arrives without isMeta — never a turn start.
        if (t.startsWith("<local-command-stdout>") || t.startsWith("<local-command-caveat>"))
            continue;
        let slash = null;
        let preview = t;
        const cmd = /<command-name>([^<]+)<\/command-name>/.exec(t);
        if (cmd) {
            slash = cmd[1].trim();
            const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
            preview = (args?.[1] ?? "").trim() || slash;
        }
        preview = preview.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS);
        const ts = r["timestamp"] ? String(r["timestamp"]) : null;
        const tsMs = ts ? Date.parse(ts) : NaN;
        const gap = prevTs != null && Number.isFinite(tsMs)
            ? Math.max(0, Math.round((tsMs - prevTs) / 60_000))
            : 0;
        if (Number.isFinite(tsMs))
            prevTs = tsMs;
        turns.push({ start_record_ref: uuid, ts, gap_minutes_before: gap, slash, preview });
        if (turns.length >= MAX_CANDIDATES)
            break;
    }
    return { chapter_contract_version: "1.0.0", runtime: "claude-code", total_candidates: turns.length, turns };
}
