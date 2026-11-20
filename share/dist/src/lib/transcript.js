// packages/ef-share-plugin/src/lib/transcript.ts
//
// What every reader of a transcript in this plugin needs, in one place. Each
// extractor used to carry its own copy of these, and the copies drifted: the
// interrupt marker was taught to hidden-records and not to chapters, so the
// chapter list offered "[Request interrupted by user…]" as a turn the person
// typed (review 2026-11-16, P-16).
import fs from "node:fs";
/** The records of a JSONL transcript. A line that is not a JSON object is skipped. */
export function* records(jsonl) {
    for (const line of jsonl.split("\n")) {
        const s = line.trim();
        if (!s)
            continue;
        let rec;
        try {
            rec = JSON.parse(s);
        }
        catch {
            continue;
        }
        if (rec && typeof rec === "object" && !Array.isArray(rec))
            yield rec;
    }
}
/** `turnOrigin` values of user records the runtime wrote, not the person (measured on 2.1.281–2.1.325). */
export const NON_HUMAN_ORIGINS = new Set(["task_notification", "peer", "scheduled", "system"]);
/** Runtime interrupt plumbing ("[Request interrupted by user for tool use]") — not something the person typed. */
export const INTERRUPT_MARKER = /^\s*\[Request interrupted by user/i;
/**
 * A text block the harness put into the user's message, not the person: the
 * desktop app prepends `<system-reminder>…</system-reminder>` (worktree, environment)
 * to a typed prompt as its own block.
 */
export function isHarnessReminder(text) {
    const t = text.trim();
    return t.startsWith("<system-reminder>") && t.endsWith("</system-reminder>");
}
/**
 * The user-visible text of a user record's content, or null when there is none
 * (tool_result-only messages, image-only messages, malformed content).
 */
export function userText(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        for (const b of content) {
            if (b && typeof b === "object" && b["type"] === "text") {
                const t = b["text"];
                if (typeof t === "string" && !isHarnessReminder(t))
                    return t;
            }
        }
    }
    return null;
}
export function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
    catch {
        return null;
    }
}
